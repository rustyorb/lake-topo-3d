/**
 * Minimal DXF R12 writer: closed polylines and text, millimetres. R12 needs no handles or tables,
 * and LightBurn, Inkscape and LibreCAD all read it.
 */

const f = (v: number) => (Math.round(v * 1000) / 1000).toString();

export function dxfPolyline(layer: string, pts: Array<[number, number]>, closed: boolean): string {
  const out = ['0', 'POLYLINE', '8', layer, '66', '1', '70', closed ? '1' : '0'];
  for (const [x, y] of pts) out.push('0', 'VERTEX', '8', layer, '10', f(x), '20', f(y));
  out.push('0', 'SEQEND', '8', layer);
  return out.join('\n');
}

export function dxfText(layer: string, x: number, y: number, heightMm: number, text: string): string {
  return ['0', 'TEXT', '8', layer, '10', f(x), '20', f(y), '40', f(heightMm), '1', text.replace(/[\r\n]+/g, ' ')].join('\n');
}

export function dxfDocument(entities: string[]): string {
  return [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1009',
    '9', '$INSUNITS', '70', '4',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    ...entities,
    '0', 'ENDSEC',
    '0', 'EOF', '',
  ].join('\n');
}
