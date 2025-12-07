
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapLayer {
  id: string;
  name: string;
  type: 'base' | 'object';
  imageData: string; // Base64 or URL
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  zIndex: number;
}

export interface GenerationConfig {
  prompt: string;
}

export interface MapSettings {
  artStyle: string;
  projection: string;
  sunDirection: string;
}

export type ActiveTool = 'pointer' | 'rectangle' | 'brush' | 'eraser';

export interface DebugLog {
  timestamp: number;
  type: 'Seamless' | 'Asset' | 'Base';
  prompt: string;
  inputImage?: string; // Base64
}
