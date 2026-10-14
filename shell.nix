# Development shell for NixOS: `nix-shell`, then `make install && make test`.
# The browser test uses the system Chromium (or set CHROMIUM=/path/to/chromium).
{ pkgs ? import <nixpkgs> { } }:
pkgs.mkShell {
  packages = [ pkgs.python3 pkgs.nodejs pkgs.gnumake ];
}
