# 📡 me2u

**Send any file, anywhere.** 
Zero sign-up. Zero storage. Direct browser-to-browser transfers, encrypted end-to-end.

![me2u](https://img.shields.io/badge/Status-Live-success?style=flat-square) ![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

## 🚀 Features
- **Unlimited File Size**: Powered by the modern File System Access API. Send massive 50GB+ files seamlessly.
- **True Peer-to-Peer (P2P)**: Files transfer directly between browsers using WebRTC. Your files never touch our servers.
- **End-to-End Encrypted**: All WebRTC data channels are encrypted by default.
- **No Signups Required**: Generate a share link or QR code instantly.
- **Premium Gen Z UI**: Sleek dark mode, glassmorphism, and neon gradient accents.

## 🛠️ Technology Stack
- **Frontend**: HTML5, CSS3, Vanilla JavaScript (No heavy frameworks!)
- **P2P Networking**: [PeerJS](https://peerjs.com/) (WebRTC wrapper)
- **Deployment**: Vercel (Static Hosting)

## 💻 Local Development
Running me2u locally is incredibly simple. Because it's a completely static site, you don't need `npm` or Node.js.

1. Clone the repository
2. Run any local web server. For example, with Python:
   ```bash
   python -m http.server 8080
   ```
3. Open `http://localhost:8080` in your browser.

## 🌍 Deployment
This project is built to be hosted statically for free.

1. Push this repository to GitHub.
2. Import the repository into **Vercel** or **Netlify**.
3. Deploy! (No build commands required).

## 📄 License
This project is open-source and available under the MIT License.
