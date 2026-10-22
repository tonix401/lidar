# Development shell for NixOS: `nix-shell`, then `make install && make test`.
# The browser test uses the system Chromium (or set CHROMIUM=/path/to/chromium).
#
# nixpkgs is pinned, so every machine gets the same tools: Bun 1.4.2, GNU Make 4.4.1
# (nixpkgs-unstable as of 2026-10-15). To move on: put another commit in `rev`, run
# `nix-prefetch-url --unpack https://github.com/NixOS/nixpkgs/archive/<rev>.tar.gz` and put the hash it prints in `sha256`.
let
  rev = "ca1659429c950a11a565b5764e37a1b704e17ec8";
  pinned = import (fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/${rev}.tar.gz";
    sha256 = "1g5rrss5fzvdkfafv94fyxah7q5vsq78aqw746r9mbn952yz1ssf";
  }) { };
in
{ pkgs ? pinned }:
pkgs.mkShell {
  packages = [ pkgs.bun pkgs.gnumake ];
}
