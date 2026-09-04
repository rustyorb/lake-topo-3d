const fs = require('fs');
// (rest of the shape generation script...)
const size = 30;
const shape = {
  type: 'complex_bays',
  aspectRatio: 1.0,
  lakeRadiusRatio: 0.15,
  rotationDeg: 0,
  bays: [
    // North-East arm
    { angleDeg: -45, distance: 0.5, radius: 0.4, depthMult: 0.5 },
    // West arm (Stone Branch)
    { angleDeg: -160, distance: 0.4, radius: 0.3, depthMult: 0.5 },
    // East arm
    { angleDeg: 10, distance: 0.2, radius: 0.2, depthMult: 1 },
    // South-West main body (dam)
    { angleDeg: 140, distance: 0.3, radius: 0.25, depthMult: 1 },
  ],
  deepestPointOffset: { x: 0.1, y: 0.1 },
  shorelineRoughness: 0
};

const rad = (shape.rotationDeg * Math.PI) / 180;
const cosR = Math.cos(rad);
const sinR = Math.sin(rad);

let rows = [];
for (let r = 0; r < size; r++) {
  const normY = (r / (size - 1)) * 2 - 1; // -1 to 1
  let out = "";
  for (let c = 0; c < size; c++) {
    const normX = (c / (size - 1)) * 2 - 1; // -1 to 1

    const rotX = normX * cosR - normY * sinR;
    const rotY = normX * sinR + normY * cosR;

    const distX = rotX / (shape.aspectRatio || 1.0);
    const distY = rotY;
    const baseDist = Math.sqrt(distX * distX + distY * distY);

    const angle = Math.atan2(distY, distX);
    let shoreNoise = 0;

    if (shape.bays) {
      for (const bay of shape.bays) {
        const bayAngleRad = (bay.angleDeg * Math.PI) / 180;
        let bayDiff = Math.abs(angle - bayAngleRad);
        if (bayDiff > Math.PI) bayDiff = 2 * Math.PI - bayDiff;
        
        if (bayDiff < 0.6) {
          const influence = Math.cos((bayDiff / 0.6) * (Math.PI / 2));
          shoreNoise += influence * bay.radius * 0.8;
        }
      }
    }

    const lakeBoundary = shape.lakeRadiusRatio + shoreNoise;
    if (baseDist <= lakeBoundary) {
      out += "##";
    } else {
      out += "..";
    }
  }
  rows.push(out);
}
fs.writeFileSync('output.txt', rows.join('\n'));
