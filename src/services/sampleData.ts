import { InspectionROI, MasterProduct, ReferenceImage } from '../types/master';

// Actual reflector layout from the production photo:
// 4 screws across the upper brackets, 2 screws in the center, 2 screws below.
// The Master Setup editor remains the final calibration authority; these are
// only the initial seed positions and can be dragged to the exact master image.
const eightScrewROIs: InspectionROI[] = [
  [0.30, 0.3333], [0.43, 0.3333], [0.57, 0.3333], [0.70, 0.3333],
  [0.38, 0.4667], [0.62, 0.4667],
  [0.42, 0.7000], [0.58, 0.7000],
].map(([x, y], index) => ({
  id: `roi-screw-${index + 1}`,
  name: `Screw #${index + 1}`,
  objectType: 'screw',
  x, y,
  radius: 0.04,
  toleranceRadius: 0.035,
  minConfidence: 0.65,
  isRequired: true,
}));

const anchors = [
  { id: 'anchor-A', name: 'Anchor A (Top-Left)', x: 0.25, y: 0.2667, searchRadius: 0.12, patchRadius: 24, description: 'Alignment fiducial A' },
  { id: 'anchor-B', name: 'Anchor B (Top-Right)', x: 0.75, y: 0.2667, searchRadius: 0.12, patchRadius: 24, description: 'Alignment fiducial B' },
  { id: 'anchor-C', name: 'Anchor C (Bottom-Left)', x: 0.25, y: 0.7333, searchRadius: 0.12, patchRadius: 24, description: 'Alignment fiducial C' },
  { id: 'anchor-D', name: 'Anchor D (Bottom-Right)', x: 0.75, y: 0.7333, searchRadius: 0.12, patchRadius: 24, description: 'Alignment fiducial D' },
];

const referenceImages: ReferenceImage[] = Array.from({ length: 8 }, (_, index) => ({
  id: `ref-${index + 1}`,
  label: `Reference ${index + 1}`,
  roiId: eightScrewROIs[index].id,
  imageUrl: '',
  description: 'Upload the approved golden reference image during Master Setup.',
}));

export const SEED_PRODUCT_A: MasterProduct = {
  id: 'prd-reflector-assy-hl-gjra',
  productCode: 'PRD-REFLECTOR-ASSY-HL-GJRA',
  productName: 'Reflector Assy HL GJRA',
  description: 'Production inspection master for an 8-screw assembly.',
  activeRevisionId: 'rev-01-8screw',
  isActive: true,
  createdAt: '2026-10-05T08:00:00Z',
  updatedAt: '2026-10-05T08:00:00Z',
  createdBy: 'System',
  revisions: [{
    id: 'rev-01-8screw',
    masterId: 'prd-reflector-assy-hl-gjra',
    revisionCode: 'REV-01',
    revisionNote: 'Initial production configuration · 8 screws',
    expectedObjectCount: 8,
    // Dimensions are populated from the actual uploaded master image.
    // Do not use a synthetic 800x600 calibration canvas.
    masterWidth: 0,
    masterHeight: 0,
    masterImageUrl: '',
    detectionZone: { x: 0.15, y: 0.15, width: 0.7, height: 0.7 },
    anchors: anchors.map((anchor) => ({ ...anchor })),
    inspectionROIs: eightScrewROIs.map((roi) => ({ ...roi })),
    referenceImages: referenceImages.map((reference) => ({ ...reference })),
    tolerance: {
      maxPositionOffsetMm: 2.5,
      maxPositionOffsetPx: 25,
      maxRotationToleranceDeg: 12,
      minAlignmentConfidence: 0.6,
      minScrewConfidence: 0.65,
      stabilizationDelayMs: 500,
      stabilizationMotionThreshold: 8,
      partRemovalThreshold: 12,
      detectionZonePresenceThreshold: 18,
    },
    createdAt: '2026-10-05T08:00:00Z',
    updatedAt: '2026-10-05T08:00:00Z',
    createdBy: 'System',
  }],
};

const getImageDimensions = (imageUrl: string): Promise<{ width: number; height: number }> =>
  new Promise((resolve) => {
    if (!imageUrl) {
      resolve({ width: 0, height: 0 });
      return;
    }
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = imageUrl;
  });

export async function initSeedDataIfEmpty() {
  const { dbService } = await import('./db');
  const existing = await dbService.getAllMasters();

  // Seed only a truly empty database. Never rewrite, canonicalize, or delete
  // registered products here: each product owns its independent inspection profile.
  if (existing.length > 0) return;

  await dbService.saveMaster(SEED_PRODUCT_A);
}
