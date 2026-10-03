{
  description = "AgentSlave — Slack-to-pull-request agent orchestration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        packages.default = pkgs.callPackage ./nix/package.nix { };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.postgresql_17
            pkgs.just
            pkgs.ripgrep
            pkgs.nixfmt
          ];
        };

        formatter = pkgs.nixfmt;
      }
    )
    // {
      nixosModules.default = import ./nix/module.nix { inherit self; };
    };
}
