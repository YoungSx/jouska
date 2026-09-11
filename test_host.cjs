const { hostMatches } = require('./packages/jouska/dist/router.js');
console.log(hostMatches('*.example.com', '.example.com'));
console.log(hostMatches('*.example.com', 'a.example.com'));
console.log(hostMatches('*.example.com', 'example.com'));
console.log(hostMatches('*.example.com', '..example.com'));
