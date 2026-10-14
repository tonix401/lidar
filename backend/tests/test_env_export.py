import json

from mrs6000 import load_env, write_scan_files
from tests.conftest import make_scan


def test_load_env(tmp_path):
    p = tmp_path / ".env"
    p.write_text("# comment\nUSERNAME=Service\nPASSWORD='a=b'\n\nBROKEN\n")
    assert load_env(str(p)) == {"USERNAME": "Service", "PASSWORD": "a=b"}
    assert load_env(str(tmp_path / "missing")) == {}


def test_write_scan_files(tmp_path, fake_rest):
    from mrs6000 import RestClient
    scan = make_scan(layers=2, beams=3, dist_mm=lambda l, b: 0.0 if b == 0 else 1500.0)
    scan.raw_telegrams = ["t1", "t2"]
    paths = write_scan_files(scan, str(tmp_path / "s"), RestClient(base_url=fake_rest.url), upside_down=True)
    assert [p.rsplit(".", 1)[-1] for p in paths] == ["txt", "csv", "ply", "json"]
    assert (tmp_path / "s.cola.txt").read_text() == "t1\nt2\n"
    rows = (tmp_path / "s.csv").read_text().strip().splitlines()
    assert len(rows) == 1 + 6                                          # every beam, incl. invalid
    ply = (tmp_path / "s.ply").read_text()
    assert "element vertex 4" in ply and "upside down" in ply
    meta = json.loads((tmp_path / "s.json").read_text())
    assert meta["valid_returns"] == 4 and meta["device"]["DeviceType"] == "MRS6224R-131001"
