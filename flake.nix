{
  description = "super-simple-osu-team-dashboard — osu! team statistics (collector + web dashboard)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }: let
    systems = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
    forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.callPackage ./nix/package.nix {};
      dashboard = self.packages.${system}.default;
    });

    apps = forAllSystems (system: let
      dashboard = self.packages.${system}.default;
    in {
      # `nix run` — starts the collector and the web backend together.
      default = {
        type = "app";
        program = "${dashboard}/bin/dashboard";
      };
      # Production runs them as separate processes (spec 8.1).
      web = {
        type = "app";
        program = "${dashboard}/bin/dashboard-web";
      };
      collector = {
        type = "app";
        program = "${dashboard}/bin/dashboard-collector";
      };
    });

    devShells = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          bun
          git
          cacert
        ];
        # Bun needs a CA bundle on NixOS for `bun install` / osu! API calls.
        SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
        NODE_EXTRA_CA_CERTS = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
        shellHook = ''
          echo "osu! team dashboard dev shell — bun $(bun --version)"
          echo "  bun install          # after changing dependencies"
          echo "  bun run dev          # collector + web backend on :3000"
          echo "  bun run test / typecheck / build"
          echo "Packaged app: nix build .# && nix run ."
        '';
      };
    });
  };
}
