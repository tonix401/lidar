import pytest

from mrs6000 import RestClient, RestError
from tests.conftest import free_port


def test_get_and_errors(fake_rest):
    rest = RestClient(base_url=fake_rest.url)
    assert rest.get("KM_SysBoard_Temp") == 41.5
    with pytest.raises(RestError):
        rest.get("NoSuchVariable")


def test_get_many_reports_rejected_variables_in_place(fake_rest):
    rest = RestClient(base_url=fake_rest.url)
    out = rest.get_many(["UpsideDown", "NoSuchVariable"])
    assert out["UpsideDown"] is True
    assert out["NoSuchVariable"].startswith("<error:")


def test_get_many_raises_at_once_on_connection_errors():
    rest = RestClient(base_url=f"http://127.0.0.1:{free_port()}/api/", timeout=1)
    with pytest.raises(OSError):
        rest.get_many(["A", "B", "C"])


def test_login_and_authenticated_write(fake_rest):
    rest = RestClient(base_url=fake_rest.url)
    assert not rest.login("Service", "wrong")
    assert rest.user == "Run"
    assert rest.login("Service", "servicelevel")
    rest.write("LocationName", "lab")
    assert fake_rest.values["LocationName"] == "lab"


def test_challenge_response_with_salt_differs():
    ch = {"realm": "R", "nonce": "N"}
    a = RestClient.challenge_response("u", "p", ch, "X")
    b = RestClient.challenge_response("u", "p", {**ch, "salt": [1, 2]}, "X")
    assert len(a) == 64 and a != b
