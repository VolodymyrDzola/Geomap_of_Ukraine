const fs = require('fs');
const mapshaper = require('mapshaper');

async function cleanTopology() {
  console.log('Починаємо автоматичне очищення топології за допомогою Mapshaper...');
  
  const inputData = fs.readFileSync('rayony.geojson', 'utf8');
  const input = { 'input.geojson': inputData };
  const commands = '-i input.geojson -clean snap-interval=0.0005 -o output.geojson format=geojson';
  
  console.log('Запускаємо алгоритм -clean...');
  return new Promise((resolve, reject) => {
    mapshaper.applyCommands(commands, input, (err, output) => {
      if (err) {
        return reject(err);
      }
      if (!output || !output['output.geojson']) {
        return reject(new Error('Mapshaper не повернув output.geojson. Ключі: ' + Object.keys(output || {}).join(', ')));
      }
      console.log('✅ Очищення завершено. Зберігаємо очищений файл...');
      fs.writeFileSync('rayony_clean.geojson', output['output.geojson']);
      console.log('🎉 Створено файл rayony_clean.geojson з виправленою топологією.');
      resolve();
    });
  });
}

cleanTopology().catch(err => {
  console.error('Помилка очищення:', err);
  process.exit(1);
});