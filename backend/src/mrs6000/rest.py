"""REST API client: GET variables, POST variables/methods with SICK's challenge-response auth."""
from __future__ import annotations

import json
import urllib.request
from hashlib import sha256

from .variables import DEFAULT_IP


class RestError(RuntimeError):
    """The device answered, but reported an error for this variable/method."""


class RestClient:
    USER_LEVELS = ("Run", "Operator", "Maintenance", "AuthorizedClient", "Service")

    def __init__(self, ip: str = DEFAULT_IP, timeout: float = 5.0, base_url: str | None = None):
        self.base = base_url or f"http://{ip}/api/"
        self.timeout = timeout
        self.user = "Run"
        self.password = ""
        # never route the sensor through an HTTP proxy
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _request(self, name: str, body: dict | None = None) -> dict:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + name, data=data, method="GET" if body is None else "POST")
        with self._opener.open(req, timeout=self.timeout) as r:
            return json.loads(r.read())

    def get(self, name: str):
        """Read one variable and return its value."""
        res = self._request(name)
        if res["header"]["status"] != 0:
            raise RestError(f"{name}: {res['header']['message']} (status {res['header']['status']})")
        return res["data"][name]

    def get_many(self, names: list[str]) -> dict:
        """Read several variables. A variable the device rejects is reported in place and the rest
        are still read; a connection problem (timeout, refused, ...) raises at once instead of
        waiting out one timeout per variable."""
        out = {}
        for n in names:
            try:
                out[n] = self.get(n)
            except (RestError, KeyError, ValueError) as e:     # device answered, but not with this variable
                out[n] = f"<error: {e}>"
        return out

    # --- authenticated POST ---------------------------------------------------------------

    def login(self, user: str, password: str) -> bool:
        """Set user level for subsequent POSTs. Default passwords of SICK LiDARs are typically
        'client' (AuthorizedClient) and 'servicelevel' (Service)."""
        self.user, self.password = user, password
        res = self._post("checkCredentials", None)
        ok = res["header"]["status"] == 0
        if not ok:
            self.user, self.password = "Run", ""
        return ok

    def write(self, name: str, value) -> dict:
        return self._post(name, {name: value})

    def call(self, method: str, args: dict | None = None) -> dict:
        return self._post(method, args)

    @staticmethod
    def challenge_response(user: str, password: str, challenge: dict, name: str) -> str:
        """SHA256 digest auth: H(H(user:realm:password[:salt]) : nonce : H(POST:name))."""
        h1 = (user + ":" + challenge["realm"] + ":").encode() + bytes(ord(c) % 256 for c in password)
        if "salt" in challenge:
            h1 += b":" + bytes(challenge["salt"])
        hash1 = sha256(h1).hexdigest()
        hash2 = sha256(f"POST:{name}".encode()).hexdigest()
        return sha256(f"{hash1}:{challenge['nonce']}:{hash2}".encode()).hexdigest()

    def _post(self, name: str, data) -> dict:
        ch = self._request("getChallenge", {"data": {"user": self.user}})["challenge"]
        header = {"user": self.user, "realm": ch["realm"], "nonce": ch["nonce"], "opaque": ch["opaque"],
                  "response": self.challenge_response(self.user, self.password, ch, name)}
        body: dict = {"header": header}
        if data is not None:
            body["data"] = data
        return self._request(name, body)
