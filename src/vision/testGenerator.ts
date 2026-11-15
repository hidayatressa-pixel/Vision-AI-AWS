/**
 * Inspection Scenario Generator
 * Provides deterministic stand scenarios for engineering verification without physical hardware.
 */

export type TestScenarioType =
  | 'EMPTY_STAND'
  | 'PERFECT_PASS'
  | 'SHIFTED_VIBRATION' // Shift and rotation scenario used to verify alignment compensation.
  | 'MISSING_SCREW_4' // NG: Screw #4 Missing
  | 'MISSING_SCREW_2' // NG: Screw #2 Missing
  | 'MISSING_SCREW_6' // NG: Screw #6 Missing
  | 'MISSING_SCREW_7' // NG: Screw #7 Missing
  | 'MISSING_SCREW_8' // NG: Screw #8 Missing
  | 'OUT_OF_TOLERANCE_SCREW_2' // NG: Screw #2 shifted 40px away
  | 'EXTRA_SCREW' // NG: extra ninth screw added in the workpiece area
  | 'ALIGNMENT_FAILURE'; // System Error: Anchors blocked/missing

export function drawWorkpieceToCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scenario: TestScenarioType
) {
  // Clear inspection table (antistatic mat)
  ctx.fillStyle = '#0b0f19';
  ctx.fillRect(0, 0, width, height);

  // Background subtle texture/grid
  ctx.strokeStyle = '#162032';
  ctx.lineWidth = 1;
  const gridStep = 40;
  for (let x = 0; x < width; x += gridStep) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += gridStep) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (scenario === 'EMPTY_STAND') {
    // Only empty table, no part present
    return;
  }

  // Bracket base geometry
  const bx = 160;
  const by = 120;
  const bw = 480;
  const bh = 360;

  // Determine offsets based on scenario
  let transX = 0;
  let transY = 0;
  let rotDeg = 0;

  if (scenario === 'SHIFTED_VIBRATION') {
    // 12px shift in X, -8px in Y, 2.5 degrees rotation
    transX = 14;
    transY = -9;
    rotDeg = 2.4;
  }

  ctx.save();
  // Translate to center of bracket, rotate, and translate back
  const cx = width / 2 + transX;
  const cy = height / 2 + transY;
  ctx.translate(cx, cy);
  ctx.rotate((rotDeg * Math.PI) / 180);
  ctx.translate(-width / 2, -height / 2);

  // Draw Workpiece Chassis
  ctx.fillStyle = '#1e293b';
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 4;
  roundRect(ctx, bx, by, bw, bh, 16, true, true);

  // Recessed inner pocket
  ctx.fillStyle = '#0f172a';
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 2;
  roundRect(ctx, bx + 16, by + 16, bw - 32, bh - 32, 10, true, true);

  // Center product label
  ctx.fillStyle = '#1e293b';
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1.5;
  roundRect(ctx, bx + bw / 2 - 70, by + bh / 2 - 25, 140, 50, 4, true, true);

  ctx.font = 'bold 12px sans-serif';
  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'center';
  ctx.fillText('M4-BRACKET', bx + bw / 2, by + bh / 2 - 5);
  ctx.font = '10px monospace';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('SN: 2026-PROD-0194', bx + bw / 2, by + bh / 2 + 15);

  // Draw Anchors A, B, C, D
  const anchors = [
    { x: bx + 40, y: by + 40, label: 'A' },
    { x: bx + bw - 40, y: by + 40, label: 'B' },
    { x: bx + 40, y: by + bh - 40, label: 'C' },
    { x: bx + bw - 40, y: by + bh - 40, label: 'D' },
  ];

  if (scenario !== 'ALIGNMENT_FAILURE') {
    for (const a of anchors) {
      drawAnchorFiducial(ctx, a.x, a.y, a.label);
    }
  } else {
    // Obstructed fiducials for alignment failure test
    drawAnchorFiducial(ctx, anchors[0].x, anchors[0].y, 'A');
    // B, C, D are missing/covered by foreign debris
    ctx.fillStyle = '#090d16';
    ctx.fillRect(anchors[1].x - 20, anchors[1].y - 20, 40, 40);
  }

  // Draw the production configuration: 8 required screws.
  const screwXs = [bx + 70, bx + 183, bx + 297, bx + 410];
  const screws: Array<{ id: number; x: number; y: number; label: string; present: boolean }> = [
    ...screwXs.map((x, index) => ({ id: index + 1, x, y: by + 80, label: `#${index + 1}`, present: true })),
    { id: 5, x: bx + 183, y: by + bh / 2 - 12, label: '#5', present: true },
    { id: 6, x: bx + 297, y: by + bh / 2 - 12, label: '#6', present: true },
    { id: 7, x: bx + 183, y: by + bh - 80, label: '#7', present: true },
    { id: 8, x: bx + 297, y: by + bh - 80, label: '#8', present: true },
  ];

  // Modify screws based on scenario
  if (scenario === 'MISSING_SCREW_4') {
    screws[3].present = false; // Screw 4 missing!
  } else if (scenario === 'MISSING_SCREW_2') {
    screws[1].present = false; // Screw 2 missing!
  } else if (scenario === 'MISSING_SCREW_6') {
    screws[5].present = false;
  } else if (scenario === 'MISSING_SCREW_7') {
    screws[6].present = false;
  } else if (scenario === 'MISSING_SCREW_8') {
    screws[7].present = false;
  } else if (scenario === 'OUT_OF_TOLERANCE_SCREW_2') {
    // Screw 2 placed 42px to the left (clearly exceeds 25px tolerance!)
    screws[1].x -= 42;
  }

  // Render screws
  for (const s of screws) {
    if (s.present) {
      drawScrew(ctx, s.x, s.y, s.label);
    } else {
      drawEmptyThreadedHole(ctx, s.x, s.y, s.label);
    }
  }

  // Extra screw scenario
  if (scenario === 'EXTRA_SCREW') {
    // An extra loose screw placed away from every configured ROI.
    drawScrew(ctx, bx + bw / 2, by + bh / 2 + 55, 'EXTRA');
  }

  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill = true,
  stroke = true
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function drawAnchorFiducial(ctx: CanvasRenderingContext2D, x: number, y: number, label: string) {
  ctx.save();
  ctx.translate(x, y);

  ctx.fillStyle = '#1e293b';
  ctx.fillRect(-16, -16, 32, 32);

  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 10, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-14, 0);
  ctx.lineTo(14, 0);
  ctx.moveTo(0, -14);
  ctx.lineTo(0, 14);
  ctx.stroke();

  ctx.fillStyle = '#38bdf8';
  ctx.beginPath();
  ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = 'bold 11px monospace';
  ctx.fillStyle = '#38bdf8';
  ctx.fillText(label, 18, 5);

  ctx.restore();
}

function drawScrew(ctx: CanvasRenderingContext2D, x: number, y: number, label: string) {
  ctx.save();
  ctx.translate(x, y);

  // Outer countersunk dark rim
  ctx.fillStyle = '#0f172a';
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Metallic screw head
  const grad = ctx.createLinearGradient(-16, -16, 16, 16);
  grad.addColorStop(0, '#cbd5e1');
  grad.addColorStop(0.4, '#94a3b8');
  grad.addColorStop(0.6, '#e2e8f0');
  grad.addColorStop(1, '#64748b');

  ctx.fillStyle = grad;
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Phillips / Torx drive cross slot
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-9, 0);
  ctx.lineTo(9, 0);
  ctx.moveTo(0, -9);
  ctx.lineTo(0, 9);
  ctx.moveTo(-4, -4);
  ctx.lineTo(4, 4);
  ctx.moveTo(-4, 4);
  ctx.lineTo(4, -4);
  ctx.stroke();

  ctx.fillStyle = '#020617';
  ctx.beginPath();
  ctx.arc(0, 0, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(label, 0, 36);

  ctx.restore();
}

function drawEmptyThreadedHole(ctx: CanvasRenderingContext2D, x: number, y: number, label: string) {
  ctx.save();
  ctx.translate(x, y);

  // Empty hole (dark void with thread ring)
  ctx.fillStyle = '#020617';
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Thread ridges
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, 12, 0, Math.PI * 2);
  ctx.stroke();

  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ef4444';
  ctx.fillText(`${label} (EMPTY)`, 0, 36);

  ctx.restore();
}
