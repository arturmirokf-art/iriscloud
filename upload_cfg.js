const fs = require('fs');
const path = require('path');
const https = require('https');

const cfgPath = 'C:\\Users\\NeVas\\AppData\\Roaming\\.tlauncher\\legacy\\Minecraft\\game\\config\\IrisShader\\configs\\db5e9406-c33c-33b5-a4f4-6a76965a08ce.cfg';
const content = fs.readFileSync(cfgPath, 'utf8');
const lines = content.split(/\r?\n/);

const decode = (s) => Buffer.from(s, 'base64').toString('utf8');

const name = decode(lines[0]);
const description = decode(lines[1]);
const data = decode(lines[2]);
const key = decode(lines[3]);
const createdAt = decode(lines[4]);
const updatedAt = decode(lines[5]);

console.log('Parsed config:', { name, description, key, createdAt, updatedAt, dataLen: data.length });

const hwid = '3ba69ddbd991ebfb18d99f0217e68176d59dc25d84be716c78fc411f29555b2c';

function post(urlStr, body, cb) {
  const url = new URL(urlStr);
  const dataStr = JSON.stringify(body);
  const req = https.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(dataStr)
    }
  }, (res) => {
    let acc = '';
    res.on('data', chunk => acc += chunk);
    res.on('end', () => cb(JSON.parse(acc)));
  });
  req.on('error', (err) => console.error('Error:', err));
  req.write(dataStr);
  req.end();
}

post('https://iriscloud-2.onrender.com/api/configs/save', {
  hwid: hwid,
  name: name,
  description: description,
  data: data,
  username: 'NeVas'
}, (saveRes) => {
  console.log('Save response:', saveRes);

  post('https://iriscloud-2.onrender.com/api/configs/share', {
    hwid: hwid,
    name: name
  }, (shareRes) => {
    console.log('Share response:', shareRes);
    console.log('\n=============================');
    console.log(`CONFIG NAME: ${name}`);
    console.log(`SHARE KEY: ${shareRes.share_key}`);
    console.log('=============================');
  });
});
