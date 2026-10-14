import socket
import urllib.error

from mrs6000 import describe_error


def test_network_errors_are_short():
    assert describe_error(socket.timeout()) == "timed out"
    assert describe_error(TimeoutError()) == "timed out"
    assert describe_error(ConnectionRefusedError(111, "Connection refused")) == "connection refused"
    assert describe_error(ConnectionResetError()) == "connection reset"
    assert describe_error(socket.gaierror(-2, "Name or service not known")) == "host not found"


def test_url_errors_unwrap_their_reason():
    assert describe_error(urllib.error.URLError(ConnectionRefusedError(111, "x"))) == "connection refused"
    assert describe_error(urllib.error.URLError("weird")) == "weird"
    e = urllib.error.HTTPError("http://x", 404, "Not Found", {}, None)
    assert describe_error(e) == "HTTP 404 Not Found"


def test_os_errors_show_only_the_file_name():
    e = FileNotFoundError(2, "No such file or directory", "/very/long/path/to/file.mrsstream")
    assert describe_error(e) == "no such file or directory: file.mrsstream"


def test_other_errors_keep_type_and_first_line_and_are_capped():
    assert describe_error(ValueError("bad\nsecond line")) == "ValueError: bad"
    assert describe_error(RuntimeError("sensor closed connection")) == "sensor closed connection"
    assert describe_error(KeyError()) == "KeyError"
    assert len(describe_error(ValueError("x" * 500))) == 120
