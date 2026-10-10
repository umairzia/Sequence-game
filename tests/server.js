// Tiny zero-dependency static file server for local testing: `npm start`.
var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json'
};

function createServer() {
  return http.createServer(function (req, res) {
    var urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    var file = path.normalize(path.join(ROOT, urlPath));
    if (file.indexOf(ROOT) !== 0) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, function (err, data) {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

module.exports = createServer;

if (require.main === module) {
  var port = Number(process.env.PORT) || 8080;
  createServer().listen(port, function () {
    console.log('Sequence on http://localhost:' + port);
  });
}
