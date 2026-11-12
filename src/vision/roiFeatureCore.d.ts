export interface RoiShapeDescriptor {
  present: boolean;
  presenceConfidence: number;
  areaRatio: number;
  contrastStrength: number;
  centroidX: number;
  centroidY: number;
  bboxWidth: number;
  bboxHeight: number;
  aspectRatio: number;
  circularity: number;
  solidity: number;
  hog: Float32Array;
  cellEdges: Float32Array;
  edgeDensity: number;
}
export function describePatch(values: Float32Array, size?: number, polarity?: 'bright_on_dark' | 'dark_on_bright' | 'contrast'): RoiShapeDescriptor;
export function compareDescriptors(a: RoiShapeDescriptor, b: RoiShapeDescriptor): number;
\nexport function rectifyPatch(frameValues: ArrayLike<number>, frameWidth: number, frameHeight: number, centerX: number, centerY: number, roiWidth: number, roiHeight: number, cos: number, sin: number, size?: number): Float32Array | null;\n