export interface BoardSample {
  ts: number;
  present: boolean;
  total_kg: number;
  TL: number;
  TR: number;
  BL: number;
  BR: number;
  cop_x: number;
  cop_y: number;
  left_share: number;
  right_share: number;
}

export type Mode = "ABSENT" | "PAN" | "ZOOM_IN" | "ZOOM_OUT";

export interface PanZoomCommand {
  panX: number;
  panY: number;
  zoom: number;
  mode: Mode;
}

export interface ModeChangeDetail {
  from: Mode;
  to: Mode;
}

export type GestureStatus = "DISCONNECTED" | "REZEROING" | "READY";

export interface StatusChangeDetail {
  from: GestureStatus;
  to: GestureStatus;
}
