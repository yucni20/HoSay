# 以獨立的 Python cryptography / PyJWT 驗證 Node 端的 Web Push 實作（模擬瀏覽器接收端）
import sys, json, base64, subprocess
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import jwt, os

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
def ub64(s): return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))
def hkdf(salt, ikm, info, n): return HKDF(hashes.SHA256(), n, salt, info).derive(ikm)

ua_priv = ec.generate_private_key(ec.SECP256R1())
ua_pub = ua_priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
auth = os.urandom(16)
msg = '{"title":"該吃維他命D了 🌱","body":"早上 08:00"}'
out = subprocess.check_output(['node', '-e', '''
const w=require("./lib/webpush");const k=w.generateVapidKeys();
const v={...k,subject:"mailto:test@example.com"};
const body=w.encryptPayload(process.argv[1],process.argv[2],process.argv[3]);
console.log(JSON.stringify({body:body.toString("base64"),auth:w.vapidAuthHeader("https://fcm.googleapis.com/fcm/send/abc",v),pub:k.publicKey}));
''', msg, b64u(ua_pub), b64u(auth)])
r = json.loads(out)
data = base64.b64decode(r['body'])
salt, rs, idlen = data[:16], int.from_bytes(data[16:20], 'big'), data[20]
as_pub = data[21:21+idlen]; ct = data[21+idlen:]
shared = ua_priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
ikm = hkdf(auth, shared, b'WebPush: info\x00' + ua_pub + as_pub, 32)
cek = hkdf(salt, ikm, b'Content-Encoding: aes128gcm\x00', 16)
nonce = hkdf(salt, ikm, b'Content-Encoding: nonce\x00', 12)
pt = AESGCM(cek).decrypt(nonce, ct, None)
assert pt[-1] == 2 and pt[:-1].decode() == msg, pt
assert rs == 4096
# VAPID JWT
hdr = r['auth']; tok = hdr.split('t=')[1].split(',')[0]; k = hdr.split('k=')[1]
assert k == r['pub']
pb = ub64(k)
pubkey = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), pb)
claims = jwt.decode(tok, pubkey, algorithms=['ES256'], audience='https://fcm.googleapis.com')
assert claims['sub'] == 'mailto:test@example.com'
print('OK: payload decrypted by independent RFC 8291 receiver; VAPID JWT verified', claims['aud'])
