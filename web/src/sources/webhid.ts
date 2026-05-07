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
 * STATUS: Validated against a real Nintendo RVL-WBC-01 (Wii Balance Board).
 * Key protocol note: the 0x21 read-reply byte[2] encodes size−1 in the HIGH
 * nibble and error in the LOW nibble — opposite to what the WiiBrew wiki says.
 * See handleReadResponse() for details. Errors surface via the `error` event.
 */

const NINTENDO_VENDOR_ID = 0x057e;
const WIIMOTE_PRODUCT_IDS = [0x0306, 0x0330] as const;

const REPORT_SET_REPORTING = 0x12;
const REPORT_WRITE_REGISTER = 0x16;
const REPORT_READ_REGISTER = 0x17;
const REPORT_WRITE_ACK = 0x22;
const REPORT_READ_RESPONSE = 0x21;
const REPORT_DATA_CORE_EXT8 = 0x32;

/** Reporting mode: core buttons + 8 extension bytes (the Balance Board fits in 8). */
const REPORTING_MODE_CORE_EXT8 = 0x32;

/** Calibration block sits in the extension's register space. */
const CALIBRATION_ADDR = 0xa40024;
const CALIBRATION_LENGTH = 24;

// Balance Board extension init: write 0x00 to 0xa40040.
// (The "new-style" 0x55/0x00 init is for Motion Plus / later extensions and
//  does not work on the Balance Board — see wiibrew.org/wiki/Wii_Balance_Board)
const EXT_INIT_ADDR = 0xa40040;
const EXT_INIT_VALUE = 0x00;

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
  private writeAckResolve: (() => void) | null = null;
  private writeAckReject: ((err: Error) => void) | null = null;
  /** Incremented each time a new calibration read is issued; stale chunks are dropped. */
  private calReadGen = 0;

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
    this.writeAckResolve = null;
    this.writeAckReject = null;
  }

  private attachInputHandler(): void {
    if (!this.device) return;
    this.inputHandler = (evt: Event) => this.onInputReport(evt as HIDInputReportEventLike);
    this.device.addEventListener("inputreport", this.inputHandler);
  }

  private async initExtension(): Promise<void> {
    if (!this.device) throw new Error("No device");
    // Balance Board uses old-style single-byte init only.
    // New-style (0x55/0x00 to 0xa400f0/0xa400fb) targets Motion Plus / later
    // extensions and is silently ignored by the Balance Board firmware.
    console.log("[WBB] initialising extension (0x00 → 0xa40040)");
    await this.writeRegister(EXT_INIT_ADDR, EXT_INIT_VALUE);
    await delay(100);
  }

  private writeRegister(address24: number, value: number): Promise<void> {
    if (!this.device) return Promise.reject(new Error("No device"));
    // Output report 0x16 layout (after the report ID, sent as `data`):
    //   [space, addr_hi, addr_mid, addr_lo, length, data0..data15]
    const buf = new Uint8Array(21);
    buf[0] = 0x04; // 0x04 = control register space (a4xxxx)
    buf[1] = (address24 >> 16) & 0xff;
    buf[2] = (address24 >> 8) & 0xff;
    buf[3] = address24 & 0xff;
    buf[4] = 1; // length
    buf[5] = value & 0xff;
    // Await a 0x22 write-ack so we know the write landed before proceeding.
    const ackPromise = new Promise<void>((resolve, reject) => {
      this.writeAckResolve = resolve;
      this.writeAckReject = reject;
      window.setTimeout(() => {
        if (this.writeAckReject) {
          // Some firmware doesn't send 0x22 — treat timeout as OK.
          console.warn("[WBB] no write-ack within 500 ms, continuing anyway");
          this.writeAckResolve?.();
          this.writeAckResolve = null;
          this.writeAckReject = null;
        }
      }, 500);
    });
    void this.device.sendReport(REPORT_WRITE_REGISTER, buf);
    return ackPromise;
  }

  private readCalibration(): Promise<BoardCalibration> {
    if (!this.device) return Promise.reject(new Error("No device"));
    this.calibrationBuffer = new Uint8Array(CALIBRATION_LENGTH);
    this.calReadGen++;                    // invalidate any in-flight stale chunks
    const myGen = this.calReadGen;
    const promise = new Promise<BoardCalibration>((resolve, reject) => {
      this.calibrationResolve = resolve;
      this.calibrationReject = reject;
      // Safety net — if the device doesn't respond within 5 s, give up.
      window.setTimeout(() => {
        if (this.calibrationReject && this.calReadGen === myGen) {
          this.calibrationReject(new Error(
            "Timed out waiting for calibration response (5 s). " +
            "Open DevTools console for raw report log."
          ));
          this.calibrationResolve = null;
          this.calibrationReject = null;
        }
      }, 5000);
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
    // Log every report so we can diagnose protocol issues (visible in DevTools console).
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    const rawHex = Array.from({ length: Math.min(data.byteLength, 21) }, (_, i) =>
      hex(data.getUint8(i))
    ).join(" ");
    console.log(`[WBB] report 0x${hex(reportId)} (${data.byteLength}B): ${rawHex}`);

    if (reportId === REPORT_WRITE_ACK) {
      this.handleWriteAck(data);
    } else if (reportId === REPORT_READ_RESPONSE) {
      this.handleReadResponse(data);
    } else if (reportId === REPORT_DATA_CORE_EXT8 && this.calibration) {
      this.handleSensorReport(data);
    }
  }

  // Report 0x22 — write register acknowledgment.
  // Layout: [btn0, btn1, reportId_acked, error_nibble<<4]
  private handleWriteAck(data: DataView): void {
    const error = data.byteLength >= 4 ? (data.getUint8(3) >> 4) & 0x0f : 0;
    if (error !== 0) {
      console.warn(`[WBB] write ack error 0x${error.toString(16)}`);
      this.writeAckReject?.(new Error(`Write register failed (ack error 0x${error.toString(16)})`));
    } else {
      this.writeAckResolve?.();
    }
    this.writeAckResolve = null;
    this.writeAckReject = null;
  }

  /**
   * Input report 0x21 layout (DataView starts AFTER the 0x21 report-ID byte):
   *   [btn0, btn1, size_error, addr_hi, addr_lo, data0..data15]
   *
   * Byte[2] (size_error):
   *   HIGH nibble (bits 7:4) = payload size − 1  (0xf → 16 bytes, 0x7 → 8 bytes)
   *   LOW  nibble (bits 3:0) = error code        (0 = OK)
   *
   * NOTE: The WiiBrew wiki shows the nibbles in the reverse order (error high,
   * size low) but that contradicts what the actual Balance Board hardware sends.
   * Validated against real hardware: 24-byte calibration arrives as
   *   chunk 1 — byte[2]=0xf0 → size=16, error=0 at addr 0x0024
   *   chunk 2 — byte[2]=0x70 → size=8,  error=0 at addr 0x0034
   * Using wiki order would decode these as size=1 / error=0xf and size=1 / error=0x7,
   * which would reject perfectly valid calibration data.
   *
   * addr_hi/lo: low 16 bits of the requested address. We ask for 24 bytes at
   * 0xa40024, so the first chunk carries 0x0024 and the second 0x0034.
   */
  private handleReadResponse(data: DataView): void {
    const BASE = 2;
    if (data.byteLength < BASE + 3) return;

    const sizeError = data.getUint8(BASE);
    const payloadLen = ((sizeError >> 4) & 0x0f) + 1; // HIGH nibble = size − 1
    const error      = sizeError & 0x0f;               // LOW  nibble = error code

    if (error !== 0) {
      const allBytes = Array.from({ length: data.byteLength }, (_, i) =>
        data.getUint8(i).toString(16).padStart(2, "0")
      ).join(" ");
      console.error(`[WBB] 0x21 read error 0x${error.toString(16)} — raw: ${allBytes}`);
      this.failCalibration(
        `Calibration read failed (error=0x${error.toString(16)}). ` +
        `Raw bytes: ${allBytes}`
      );
      return;
    }

    const addrLow = data.getUint16(BASE + 1);
    const offset = addrLow - (CALIBRATION_ADDR & 0xffff);
    if (offset < 0 || offset + payloadLen > CALIBRATION_LENGTH) {
      // Stale chunk from a prior read, or a completely unrelated address.
      console.warn(`[WBB] 0x21 chunk ignored: addrLow=0x${addrLow.toString(16)} offset=${offset} payloadLen=${payloadLen}`);
      return;
    }
    for (let i = 0; i < payloadLen; i++) {
      this.calibrationBuffer[offset + i] = data.getUint8(BASE + 3 + i);
    }
    console.log(`[WBB] calibration chunk ok: offset=${offset} len=${payloadLen} (${offset + payloadLen}/${CALIBRATION_LENGTH} bytes)`);
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
