import http.server
import os
os.chdir('/Users/jwars/Desktop/Claude/fantasy-league')
http.server.test(HandlerClass=http.server.SimpleHTTPRequestHandler, port=8090)
