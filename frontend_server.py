#!/usr/bin/env python3
"""
Gasterus V3 - Simple Frontend Server
Untuk development preview tanpa backend
"""
import http.server
import socketserver
import os
from pathlib import Path

PORT = 3000
DIRECTORY = Path(__file__).parent / 'frontend'

class MyHttpRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)
    
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

os.chdir(DIRECTORY)
Handler = MyHttpRequestHandler

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"""
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║     GASTERUS V3 - Frontend Server                        ║
║                                                           ║
║     📍 http://localhost:{PORT}                          ║
║     📁 {DIRECTORY}                              ║
║                                                           ║
║     Fitur yang tersedia:                                  ║
║     - Beranda (index.html)                                ║
║     - Halaman Login (login.html) ✅                       ║
║     - Halaman Register (register.html)                   ║
║     - Member Area (member.html)                          ║
║     - Market Play (market-play.html)                     ║
║     - Style & Assets                                     ║
║                                                           ║
║     ⚠️  Backend belum berjalan:                           ║
║     - Login/taroohan tidak akan berfungsi                ║
║     - Lihat server.log untuk info backend                ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
""")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer dihentikan.")
        httpd.shutdown()