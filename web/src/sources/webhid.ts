import { BaseSampleSource } from "./base";
import type { SourceId } from "./types";

/**
 * Direct browser-to-board driver via the WebHID API. No bridge process required.
 *
 * Supported on Chrome / Edge desktop (Windows / Mac / Linux). The user must
 * have already paired the board via the OS Bluetooth settings — WebHID does
 * not handle pairing itself, only HID transport.
 *
 * Protocol reference: https://wiibrew.org/wiki/Wii_Balance_Board
 *
 * STATUS: This driver is implemented from the spec but has not yet been
 * validated end-to-end against real hardware in this codebase. Errors during
 * init are surfaced via the `error` event with a descriptive message; the
 * picker UI exposes them so misconfiguration is visible rather than silent.
 */

const NINTENDO_VENDOR_ID = 0x057e;
const WIIMOTE_PRODUCT_IDS = [0x0306, 0x0330] as const;

const REPORT_SET_REPORTING = 0x12;
const REPORT_WRITE_REGISTER = 0x16;
const REPORT_READ_REGISTER = 0x17;
const REPORT_READ_RESPONSE = 0x21;
const REPORT_DATA_CORE_EXT8 = 0x32;

/** Reporting mode: core buttons + 8 extension bytes (the Balance Board fits in 8). */
const REPORTING_MODE_CORE_EXT8 = 0x32;

/** Calibration block sits in the extension's register space. */
const CALIBRATION_ADDR = 0xa40024;
const CALIBRATION_LENGTH = 24;

// Extension init: write 0x55 to 0xa400f0, then 0x00 to 0xa400fb (non-encrypted).
const EXT_INIT_ADDR_1 = 0xa400f0;
const EXT_INIT_VALUE_1 = 0x55;
const EXT_INIT_ADDR_2 = 0xa400fb;
const EXT_INIT_VALUE_2 = 0x00;

// Continuous reporting flag for output report 0x12.
const CONTINUOUS_REPORTING = 0x04;

// Per-corner calibration: 3 reference weights at 0 kg, 17 kg, 34 kg.
interface CornerCalibration {
  ref0: number;
  ref17: number;
  ref34: number;
}

interface BoardCalibration {
  TR: CornerCalibration;
  BR: CornerCalibration;
  TL: CornerCalibration;
  BL: CornerCalibration;
}

interface NavigatorWithHID extends Navigator {
  hid?: {
    requestDevice(opts: { filters: { vendorId: number; productId?: number }[] }): Promise<HIDDeviceLike[]>;
    getDevices(): Promise<HIDDeviceLike[]>;
  };
}

// Minimal HID typings; @types/wicg-mediasession etc. don't ship full WebHID types
// across all our targets, so we declare just what we touch.
interface HIDDeviceLike extends EventTarget {
  vendorId: number;
  productId: number;
  productName: string;
  opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
}

interface HIDInputReportEventLike extends Event {
  device: HIDDeviceLike;
  reportId: number;
  data: DataView;
}

export class WebHIDSource extends BaseSampleSource {
  readonly id: SourceId = "webhid";
  readonly displayName = "Wii Balance Board (WebHID)";

  private device: HIDDeviceLike | null = null;
  private calibration: BoardCalibration | null = null;
  private inputHandler: ((evt: Event) => void) | null = null;
  private calibrationBuffer: Uint8Array = new Uint8Array(0);
  private calibrationResolve: ((cal: BoardCalibration) => void) | null = null;
  private calibrationReject: ((err: Error) => void) | null = null;

  static isSupported(): boolean {
    return "hid" in navigator && typeof (navigator as NavigatorWithHID).hid?.requestDevice === "function";
  }

  async start(): Promise<void> {
    if (!WebHIDSource.isSupported()) {
      this.emitError("WebHID is not supported in this browser. Use Chrome or Edge.");
      throw new Error("WebHID unsupported");
    }
    this.setStatus("connecting", "select your paired Balance Board");

    try {
      const hid = (navigator as NavigatorWithHID).hid!;
      const devices = await hid.requestDevice({
        filters: WIIMOTE_PRODUCT_IDS.map((productId) => ({
          vendorId: NINTENDO_VENDOR_ID,
          productId,
        })),
      });
      if (devices.length === 0) {
        this.setStatus("idle", "no device selected");
        throw new Error("No device selected");
      }
      this.device = devices[0]!;
      if (!this.device.opened) await this.device.open();

      this.attachInputHandler();
      this.setStatus("connecting", "initializing extension");
      await this.initExtension();
      this.setStatus("connecting", "reading calibration");
      this.calibration = await this.readCalibration();
      this.setStatus("connecting", "starting data stream");
      await this.setReportingMode();
      this.setStatus("connected");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitError(`WebHID init failed: ${message}`);
      this.cleanup();
      throw err;
    }
  }

  stop(): void {
    this.cleanup();
    this.setStatus("disconnected");
  }

  private cleanup(): void {
    if (this.device && this.inputHandler) {
      this.device.removeEventListener("inputreport", this.inputHandler);
      this.inputHandler = null;
    }
    if (this.device && this.device.opened) {
      this.device.close().catch(() => undefined);
    }
    this.device = null;
    this.calibration = null;
  }

  private attachInputHandler(): void {
    if (!this.device) return;
    this.inputHandler = (evt: Event) => this.onInputReport(evt as HIDInputReportEventLike);
    this.device.addEventListener("inputreport", this.inputHandler);
  }

  private async initExtension(): Promise<void> {
    if (!this.device) throw new Error("No device");
    await this.writeRegister(EXT_INIT_ADDR_1, EXT_INIT_VALUE_1);
    await delay(40);
    await this.writeRegister(EXT_INIT_ADDR_2, EXT_INIT_VALUE_2);
    await delay(40);
  }

  private writeRegister(address24: number, value: number): Promise<void> {
    if (!this.device) return Promise.reject(new Error("No device"));
    // Output report 0x16 layout (after the report ID, sent as `data`):
    //   [space, addr_hi, addr_mid, addr_lo, length, data0..data15]
    // total = 21 bytes; `data` therefore is 20 bytes.
    const buf = new Uint8Array(20);
    buf[0] = 0x04; // 0x04 = control register space (a4xxxx)
    buf[1] = (address24 >> 16) & 0xff;
    buf[2] = (address24 >> 8) & 0xff;
    buf[3] = address24 & 0xff;
    buf[4] = 1; // length
    buf[5] = value & 0xff;
    return this.device.sendReport(REPORT_WRITE_REGISTER, buf);
  }

  private readCalibration(): Promise<BoardCalibration> {
    if (!this.device) return Promise.reject(new Error("No device"));
    this.calibrationBuffer = new Uint8Array(CALIBRATION_LENGTH);
    const promise = new Promise<BoardCalibration>((resolve, reject) => {
      this.calibrationResolve = resolve;
      this.calibrationReject = reject;
      // Safety net — if the device doesn't respond within 2 s, give up.
      window.setTimeout(() => {
        if (this.calibrationReject) {
          this.calibrationReject(new Error("Timed out waiting for calibration response"));
          this.calibrationResolve = null;
          this.calibrationReject = null;
        }
      }, 2000);
    });

    // Output report 0x17 layout: [space, addr_hi, addr_mid, addr_lo, len_hi, len_lo]
    // padded out to 6 bytes here; the device ignores trailing bytes.
    const buf = new Uint8Array(6);
    buf[0] = 0x04;
    buf[1] = (CALIBRATION_ADDR >> 16) & 0xff;
    buf[2] = (CALIBRATION_ADDR >> 8) & 0xff;
    buf[3] = CALIBRATION_ADDR & 0xff;
    buf[4] = (CALIBRATION_LENGTH >> 8) & 0xff;
    buf[5] = CALIBRATION_LENGTH & 0xff;
    void this.device.sendReport(REPORT_READ_REGISTER, buf);
    return promise;
  }

  private async setReportingMode(): Promise<void> {
    if (!this.device) throw new Error("No device");
    const buf = new Uint8Array(2);
    buf[0] = CONTINUOUS_REPORTING;
    buf[1] = REPORTING_MODE_CORE_EXT8;
    await this.device.sendReport(REPORT_SET_REPORTING, buf);
  }

  private onInputReport(evt: HIDInputReportEventLike): void {
    const { reportId, data } = evt;
    if (reportId === REPORT_READ_RESPONSE) {
      this.handleReadResponse(data);
    } else if (reportId === REPORT_DATA_CORE_EXT8 && this.calibration) {
      this.handleSensorReport(data);
    }
  }

  /**
   * Input report 0x21 layout (after the 0x21 report-ID byte, presented as DataView):
   *   [btn0, btn1, error_size, addr_hi, addr_lo, data0..data15]
   * - error_size: high nibble = error (0 = OK, 7 = address out of range, etc.)
   *               low nibble = bytes-1 of payload (0..15 for 1..16 bytes)
   * - addr_hi/lo: low 16 bits of source address; we requested 0xa40024 so the
   *               first chunk has 0x0024 and the second 0x0034 (for our 24 byte read).
   * The 24-byte calibration arrives in two 16-byte chunks.
   */
  private handleReadResponse(data: DataView): void {
    if (data.byteLength < 5) return;
    const errorSize = data.getUint8(2);
    const error = (errorSize >> 4) & 0x0f;
    if (error !== 0) {
      this.failCalibration(`Read error 0x${error.toString(16)} from device`);
      return;
    }
    const payloadLen = (errorSize & 0x0f) + 1;
    const addrLow = data.getUint16(3);
    // Locate this chunk inside our 24-byte calibration buffer.
    const offset = addrLow - (CALIBRATION_ADDR & 0xffff);
    if (offset < 0 || offset + payloadLen > CALIBRATION_LENGTH) return;
    for (let i = 0; i < payloadLen; i++) {
      this.calibrationBuffer[offset + i] = data.getUint8(5 + i);
    }
    if (offset + payloadLen >= CALIBRATION_LENGTH) {
      this.completeCalibration();
    }
  }

  private completeCalibration(): void {
    const view = new DataView(this.calibrationBuffer.buffer);
    const cornerAt = (offset: number): CornerCalibration => ({
      ref0:  view.getUint16(offset),
      ref17: view.getUint16(offset + 8),
      ref34: view.getUint16(offset + 16),
    });
    const cal: BoardCalibration = {
      TR: cornerAt(0),
      BR: cornerAt(2),
      TL: cornerAt(4),
      BL: cornerAt(6),
    };
    if (this.calibrationResolve) {
      this.calibrationResolve(cal);
      this.calibrationResolve = null;
      this.calibrationReject = null;
    }
  }

  private failCalibration(reason: string): void {
    if (this.calibrationReject) {
      this.calibrationReject(new Error(reason));
      this.calibrationResolve = null;
      this.calibrationReject = null;
    }
  }

  /**
   * Input report 0x32 (core buttons + 8 ext bytes), as a DataView starting AFTER
   * the report-ID byte:
   *   [btn0, btn1, ext0..ext7]
   * Balance Board extension layout (ext0..ext7), each 16-bit big-endian:
   *   ext0..1: TR raw
   *   ext2..3: BR raw
   *   ext4..5: TL raw
   *   ext6..7: BL raw
   */
  private handleSensorReport(data: DataView): void {
    if (data.byteLength < 10 || !this.calibration) return;
    const rawTR = data.getUint16(2);
    const rawBR = data.getUint16(4);
    const rawTL = data.getUint16(6);
    const rawBL = data.getUint16(8);

    const TR = rawToKg(rawTR, this.calibration.TR);
    const BR = rawToKg(rawBR, this.calibration.BR);
    const TL = rawToKg(rawTL, this.calibration.TL);
    const BL = rawToKg(rawBL, this.calibration.BL);

    const total = TL + TR + BL + BR;
    if (total < 15) {
      this.emitSample({
        ts: Date.now() / 1000,
        present: false,
        total_kg: total,
        TL, TR, BL, BR,
        cop_x: 0, cop_y: 0,
        left_share: 0, right_share: 0,
      });
      return;
    }
    const left = TL + BL;
    const right = TR + BR;
    const front = TL + TR;
    const back = BL + BR;
    this.emitSample({
      ts: Date.now() / 1000,
      present: true,
      total_kg: total,
      TL, TR, BL, BR,
      cop_x: (right - left) / total,
      cop_y: (front - back) / total,
      left_share: left / total,
      right_share: right / total,
    });
  }
}

function rawToKg(raw: number, c: CornerCalibration): number {
  if (c.ref17 === c.ref0 || c.ref34 === c.ref17) return 0;
  if (raw < c.ref17) {
    return Math.max(0, (17 * (raw - c.ref0)) / (c.ref17 - c.ref0));
  }
  return Math.max(0, 17 + (17 * (raw - c.ref17)) / (c.ref34 - c.ref17));
}

const delay = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
