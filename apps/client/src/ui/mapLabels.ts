// Canvas-independent label placement. Markers stay at their projected positions; labels can stack
// above/below or flip sides. A crowded map drops lower-priority names rather than overwriting them.
export interface MapLabel {
  id: string;
  x: number;
  y: number;
  width: number;
  /** Portals/pads = 3, shops/NPCs = 2, landmarks = 1. */
  priority: number;
}

export interface PlacedMapLabel extends MapLabel {
  left: number;
  top: number;
  height: number;
}

export function layoutMapLabels(
  labels: readonly MapLabel[], width: number, height: number,
  markers: readonly { x: number; y: number; radius: number }[] = labels.map((p) => ({ ...p, radius: 6 })),
): PlacedMapLabel[] {
  const margin = 6, gap = 4, labelHeight = 16;
  const placed: PlacedMapLabel[] = [];
  for (const label of [...labels].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
    if (label.width > width - margin * 2 || height < labelHeight + margin * 2) continue;
    const centers = [label.x, label.x + label.width / 2 + 12, label.x - label.width / 2 - 12];
    let found = false;
    for (const center of centers) {
      for (const offset of [0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100]) {
        const left = Math.max(margin, Math.min(width - margin - label.width, center - label.width / 2));
        const top = Math.max(margin, Math.min(height - margin - labelHeight, label.y - labelHeight - 10 + offset));
        if (markers.some((m) => m.x + m.radius >= left && m.x - m.radius <= left + label.width && m.y + m.radius >= top && m.y - m.radius <= top + labelHeight)) continue;
        if (placed.some((p) => left < p.left + p.width + gap && left + label.width + gap > p.left && top < p.top + p.height + gap && top + labelHeight + gap > p.top)) continue;
        placed.push({ ...label, left, top, height: labelHeight });
        found = true;
        break;
      }
      if (found) break;
    }
  }
  return placed;
}
