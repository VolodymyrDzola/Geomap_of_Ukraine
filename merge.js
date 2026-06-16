const fs = require('fs');
const path = require('path');
const mapshaper = require('mapshaper');

async function main() {
  console.log('Починаємо аналіз кордонів у файлі rayony.geojson...');

  const rayonyPath = 'rayony.geojson';
  const regionyPath = 'regiony.geojson';

  if (!fs.existsSync(rayonyPath)) {
    console.error('❌ Помилка: файл rayony.geojson не знайдено!');
    process.exit(1);
  }
  if (!fs.existsSync(regionyPath)) {
    console.error('❌ Помилка: файл regiony.geojson не знайдено!');
    process.exit(1);
  }

  const rayonyData = JSON.parse(fs.readFileSync(rayonyPath, 'utf8'));
  const regionsData = JSON.parse(fs.readFileSync(regionyPath, 'utf8'));

  // 1. Спочатку виділяємо контур Києва з оригінальних coordinates,
  // щоб зберегти всі точки та анклави без деформації.
  console.log('Шукаємо контур Києва в оригінальних координатах...');

  const kyivBox = { minX: 30.1, maxX: 30.9, minY: 50.1, maxY: 50.7 };

  function inKyivBox(x, y) {
    return x >= kyivBox.minX && x <= kyivBox.maxX && y >= kyivBox.minY && y <= kyivBox.maxY;
  }

  const segments = new Map();

  function addSegment(p1, p2) {
    if (!p1 || !p2) return;
    if (!inKyivBox(p1[0], p1[1]) || !inKyivBox(p2[0], p2[1])) return;
    const k1 = p1[0].toFixed(6) + ',' + p1[1].toFixed(6);
    const k2 = p2[0].toFixed(6) + ',' + p2[1].toFixed(6);
    const key = k1 < k2 ? k1 + '_' + k2 : k2 + '_' + k1;
    
    if (segments.has(key)) {
      segments.get(key).count++;
    } else {
      segments.set(key, { p1, p2, count: 1 });
    }
  }

  rayonyData.features.forEach(f => {
    const geom = f.geometry;
    if (!geom) return;
    const coords = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    if (!coords) return;
    coords.forEach(polygon => {
      polygon.forEach(ring => {
        for (let i = 0; i < ring.length - 1; i++) {
          addSegment(ring[i], ring[i+1]);
        }
      });
    });
  });

  const boundarySegments = Array.from(segments.values()).filter(s => s.count === 1);

  const adj = new Map();
  function addEdge(u, v, pU, pV) {
    if (!adj.has(u)) adj.set(u, { pt: pU, neighbors: new Set() });
    if (!adj.has(v)) adj.set(v, { pt: pV, neighbors: new Set() });
    adj.get(u).neighbors.add(v);
    adj.get(v).neighbors.add(u);
  }

  boundarySegments.forEach(s => {
    const u = s.p1[0].toFixed(6) + ',' + s.p1[1].toFixed(6);
    const v = s.p2[0].toFixed(6) + ',' + s.p2[1].toFixed(6);
    addEdge(u, v, s.p1, s.p2);
  });

  const visited = new Set();
  const loops = [];

  for (const [startKey, startVal] of adj.entries()) {
    if (visited.has(startKey)) continue;
    
    const loop = [];
    let current = startKey;
    let prev = null;
    let validLoop = true;
    
    while (true) {
      visited.add(current);
      const val = adj.get(current);
      if (!val) {
        validLoop = false;
        break;
      }
      loop.push(val.pt);
      
      let next = null;
      for (const neighbor of val.neighbors) {
        if (neighbor !== prev) {
          next = neighbor;
          break;
        }
      }
      
      if (!next) {
        validLoop = false;
        break;
      }
      
      if (visited.has(next)) {
        const nextVal = adj.get(next);
        if (nextVal) {
          loop.push(nextVal.pt);
        }
        break;
      }
      
      prev = current;
      current = next;
    }
    
    if (validLoop && loop.length > 3) {
      loops.push(loop);
    }
  }

  if (loops.length === 0) {
    console.error('❌ Помилка: не вдалося виділити контури Києва.');
    process.exit(1);
  }

  loops.sort((a, b) => b.length - a.length);
  const outerBoundary = loops[0];
  const otherLoops = loops.slice(1);

  function isPointInPolygon(point, polygon) {
    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1];
      const xj = polygon[j][0], yj = polygon[j][1];
      const intersect = ((yi > y) !== (yj > y))
          && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  const holes = [];
  otherLoops.forEach(loop => {
    if (isPointInPolygon(loop[0], outerBoundary)) {
      holes.push(loop);
    }
  });

  console.log(`✅ Виділено межу Києва (${outerBoundary.length} точок) з ${holes.length} анклавами.`);

  const kyivFeature = {
    "type": "Feature",
    "properties": {
      "rayon": "Місто Київ"
    },
    "geometry": {
      "type": "Polygon",
      "coordinates": [outerBoundary, ...holes]
    }
  };

  // Зливаємо Київ у масив фіч
  rayonyData.features.push(kyivFeature);

  // Зливаємо Севастополь у масив фіч з regiony.geojson (оскільки він був відсутній у файлі районів)
  const sevastopolFeature = regionsData.features.find(f => f.properties.region === 'Севастополь');
  if (sevastopolFeature) {
    const sevFeatureForMap = {
      "type": "Feature",
      "properties": {
        "rayon": "Місто Севастополь"
      },
      "geometry": sevastopolFeature.geometry
    };
    rayonyData.features.push(sevFeatureForMap);
    console.log('✅ Додано контур Севастополя до масиву перед очищенням.');
  }

  // 2. Очищення загальної топології карти (включаючи кордони Севастополя та АР Крим) через Mapshaper
  console.log('Запускаємо вбудований Mapshaper для зшивання кордонів та очищення топології (-clean)...');
  
  const mapshaperInput = { 'input.geojson': JSON.stringify(rayonyData) };
  const mapshaperCommands = '-i input.geojson -clean snap-interval=0.0005 -o output.geojson format=geojson';

  const cleanedData = await new Promise((resolve, reject) => {
    mapshaper.applyCommands(mapshaperCommands, mapshaperInput, (err, output) => {
      if (err) return reject(err);
      if (!output || !output['output.geojson']) {
        return reject(new Error('Mapshaper не повернув результат.'));
      }
      resolve(JSON.parse(output['output.geojson']));
    });
  });

  console.log('✅ Очищення топології завершено. Всі кордони зшито.');

  // 3. Визначення приналежності районів до областей (point-in-polygon)
  function isPointInMultiPolygon(point, coordinates) {
    for (const polygon of coordinates) {
      const outerRing = polygon[0];
      if (isPointInPolygon(point, outerRing)) {
        let inHole = false;
        for (let i = 1; i < polygon.length; i++) {
          if (isPointInPolygon(point, polygon[i])) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return true;
      }
    }
    return false;
  }

  function getCentroid(coords, type) {
    let ring;
    if (type === 'Polygon') {
      ring = coords[0];
    } else if (type === 'MultiPolygon') {
      ring = coords[0][0];
    }
    if (!ring || ring.length === 0) return null;
    let sumX = 0, sumY = 0;
    ring.forEach(pt => {
      sumX += pt[0];
      sumY += pt[1];
    });
    return [sumX / ring.length, sumY / ring.length];
  }

  const fallbackOblasts = {
    "бердянськийрайон": "Запорізька область",
    "перекопськийрайон": "Автономна Республіка Крим",
    "ізмаїльськийрайон": "Одеська область",
    "київ": "Київ",
    "севастополь": "Севастополь",
    "містокиїв": "Київ",
    "містосевастополь": "Севастополь"
  };

  const featureOblastCodes = cleanedData.features.map((f, index) => {
    const name = f.properties.rayon || f.properties.name || '';
    const normName = name.toLowerCase().replace(/[’'’`\s-]/g, '');

    if (fallbackOblasts[normName]) {
      return fallbackOblasts[normName];
    }
    if (normName.includes('київ')) {
      return 'Київ';
    }
    if (normName.includes('севастополь')) {
      return 'Севастополь';
    }

    const pt = getCentroid(f.geometry.coordinates, f.geometry.type);
    if (!pt) {
      return `UNKNOWN_${index}`;
    }

    let foundRegion = null;
    for (const reg of regionsData.features) {
      const regGeom = reg.geometry;
      const isInside = regGeom.type === 'Polygon' 
        ? isPointInPolygon(pt, regGeom.coordinates[0])
        : isPointInMultiPolygon(pt, regGeom.coordinates);
      
      if (isInside) {
        foundRegion = reg.properties.region;
        break;
      }
    }

    return foundRegion || `UNKNOWN_${index}`;
  });

  // Записуємо фінальну карту районів
  fs.writeFileSync('ukraine_final_map.geojson', JSON.stringify(cleanedData, null, 2));
  console.log('🎉 Файл ukraine_final_map.geojson створено.');

  // 4. Генерація точних міжобласних кордонів та державного кордону
  console.log('Будуємо точні міжобласні та державні кордони...');

  const borderSegments = new Map();

  function keyFromPoints(p1, p2) {
    const k1 = p1[0].toFixed(6) + ',' + p1[1].toFixed(6);
    const k2 = p2[0].toFixed(6) + ',' + p2[1].toFixed(6);
    return k1 < k2 ? k1 + '_' + k2 : k2 + '_' + k1;
  }

  cleanedData.features.forEach((f, featureIdx) => {
    const geom = f.geometry;
    if (!geom) return;
    const coords = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    if (!coords) return;
    coords.forEach(polygon => {
      polygon.forEach(ring => {
        for (let i = 0; i < ring.length - 1; i++) {
          const p1 = ring[i];
          const p2 = ring[i+1];
          const key = keyFromPoints(p1, p2);
          
          if (!borderSegments.has(key)) {
            borderSegments.set(key, { p1, p2, features: new Set() });
          }
          borderSegments.get(key).features.add(featureIdx);
        }
      });
    });
  });

  const stateBorderLines = [];
  const oblastBorderLines = [];

  for (const [key, val] of borderSegments.entries()) {
    const featureIdxs = Array.from(val.features);
    const len = featureIdxs.length;
    if (len === 1) {
      // Державний кордон
      stateBorderLines.push([val.p1, val.p2]);
    } else if (len >= 2) {
      const oblast1 = featureOblastCodes[featureIdxs[0]];
      const oblast2 = featureOblastCodes[featureIdxs[1]];
      if (oblast1 !== oblast2) {
        // Міжобласний кордон
        oblastBorderLines.push([val.p1, val.p2]);
      }
    }
  }

  const borderGeoJSON = {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "properties": {
          "border_type": "state"
        },
        "geometry": {
          "type": "MultiLineString",
          "coordinates": stateBorderLines
        }
      },
      {
        "type": "Feature",
        "properties": {
          "border_type": "oblast"
        },
        "geometry": {
          "type": "MultiLineString",
          "coordinates": oblastBorderLines
        }
      }
    ]
  };

  fs.writeFileSync('precise_oblast_borders.geojson', JSON.stringify(borderGeoJSON, null, 2));
  console.log('🎉 Успішно створено державні та міжобласні кордони у файлі precise_oblast_borders.geojson!');
}

main().catch(err => {
  console.error('❌ Помилка роботи скрипта:', err);
  process.exit(1);
});