const { PeerServer } = require('peer');

const port = process.env.PORT || 9000;

const peerServer = PeerServer({
  port: port,
  path: '/me2u',
  allow_discovery: false,
  alive_timeout: 60000,
  cleanup_out_msgs: 1000,
  concurrent_limit: 5000,
  proxied: true,
  corsOptions: {
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
  },
});

peerServer.on('connection', (client) => {
  console.log(`[+] Peer connected: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`[-] Peer disconnected: ${client.getId()}`);
});

console.log(`me2u signaling server running on port ${port}`);
