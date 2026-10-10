{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.agentslave;
  databaseUrl = "postgresql://${cfg.database.user}@/${cfg.database.name}?host=/run/postgresql";
  commonEnvironment = {
    NODE_ENV = "production";
    DATABASE_URL = databaseUrl;
    HOME = "/var/lib/agentslave";
    INCUS_CONF = "/var/lib/agentslave/incus";
    OBJECT_STORE_ROOT = cfg.objectStorePath;
    PORT = toString cfg.port;
    WORKER_ENABLED = if cfg.worker.enable then "true" else "false";
    INCUS_PROJECT = cfg.incus.project;
    INCUS_IMAGE = cfg.incus.image;
    INCUS_CPU = toString cfg.incus.cpu;
    INCUS_MEMORY = cfg.incus.memory;
    INCUS_AUTO_DELETE = if cfg.incus.autoDelete then "true" else "false";
  };
  serviceHardening = {
    User = "agentslave";
    Group = "agentslave";
    EnvironmentFile = "-${cfg.environmentFile}";
    NoNewPrivileges = true;
    PrivateTmp = true;
    ProtectHome = true;
    ProtectSystem = "strict";
  };
in
{
  options.services.agentslave = {
    enable = lib.mkEnableOption "AgentSlave orchestration service";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "AgentSlave package to run.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 7310;
    };

    environmentFile = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/agentslave-secrets/agentslave.env";
    };

    objectStorePath = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/agentslave/objects";
    };

    worker.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
    };

    database = {
      name = lib.mkOption {
        type = lib.types.str;
        default = "agentslave";
      };
      user = lib.mkOption {
        type = lib.types.str;
        default = "agentslave";
      };
    };

    incus = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
      };
      buildImage = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Build the reusable OpenCode worker image when it is absent.";
      };
      project = lib.mkOption {
        type = lib.types.str;
        default = "agentslave";
      };
      image = lib.mkOption {
        type = lib.types.str;
        default = "agentslave-worker";
      };
      cpu = lib.mkOption {
        type = lib.types.ints.positive;
        default = 2;
      };
      memory = lib.mkOption {
        type = lib.types.str;
        default = "2GiB";
      };
      autoDelete = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Delete an Incus workspace immediately after its run finishes.";
      };
      maxAgeSeconds = lib.mkOption {
        type = lib.types.ints.positive;
        default = 3600;
        description = "Hard maximum lifetime for AgentSlave Incus instances.";
      };
      reapInterval = lib.mkOption {
        type = lib.types.str;
        default = "1m";
        description = "How often to remove AgentSlave Incus instances older than maxAgeSeconds.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.worker.enable -> cfg.incus.enable;
        message = "services.agentslave.worker.enable requires services.agentslave.incus.enable";
      }
    ];

    users.groups.agentslave = { };
    users.users.agentslave = {
      isSystemUser = true;
      group = "agentslave";
      extraGroups = lib.optional cfg.incus.enable "incus-admin";
    };

    systemd.tmpfiles.rules = [
      "d /var/lib/agentslave-secrets 0750 root agentslave - -"
      "d /var/lib/agentslave 0750 agentslave agentslave - -"
      "d /var/lib/agentslave/incus 0750 agentslave agentslave - -"
      "d ${cfg.objectStorePath} 0750 agentslave agentslave - -"
    ];

    services.postgresql = {
      enable = true;
      ensureDatabases = [ cfg.database.name ];
      ensureUsers = [
        {
          name = cfg.database.user;
          ensureDBOwnership = true;
        }
      ];
    };

    # The upstream NixOS Incus module requires the nftables firewall backend.
    networking.nftables.enable = lib.mkDefault cfg.incus.enable;
    networking.firewall.trustedInterfaces = lib.mkIf cfg.incus.enable [ "incusbr0" ];

    virtualisation.incus = lib.mkIf cfg.incus.enable {
      enable = true;
      preseed = {
        networks = [
          {
            name = "incusbr0";
            type = "bridge";
            config = {
              "ipv4.address" = "auto";
              "ipv4.nat" = "true";
              "ipv6.address" = "none";
            };
          }
        ];
        storage_pools = [
          {
            name = "default";
            driver = "dir";
          }
        ];
        profiles = [
          {
            name = "default";
            devices = {
              eth0 = {
                name = "eth0";
                network = "incusbr0";
                type = "nic";
              };
              root = {
                path = "/";
                pool = "default";
                type = "disk";
              };
            };
          }
        ];
      };
    };

    systemd.services.agentslave-migrate = {
      description = "Apply AgentSlave database migrations";
      after = [
        "postgresql.service"
        "postgresql-setup.service"
      ];
      requires = [
        "postgresql.service"
        "postgresql-setup.service"
      ];
      before = [ "agentslave.service" ];
      requiredBy = [ "agentslave.service" ];
      environment = commonEnvironment;
      serviceConfig = serviceHardening // {
        Type = "oneshot";
        ExecStart = "${cfg.package}/bin/agentslave-migrate";
        Restart = "no";
      };
    };

    systemd.services.agentslave-incus-image = lib.mkIf (cfg.incus.enable && cfg.incus.buildImage) {
      description = "Build the AgentSlave OpenCode Incus image";
      after = [
        "network-online.target"
        "incus.service"
        "incus-preseed.service"
      ];
      wants = [ "network-online.target" ];
      requires = [
        "incus.service"
        "incus-preseed.service"
      ];
      before = [ "agentslave.service" ];
      requiredBy = [ "agentslave.service" ];
      path = [ config.virtualisation.incus.clientPackage ];
      environment = commonEnvironment;
      script = ''
        if incus --project "${cfg.incus.project}" image alias list --format csv | ${pkgs.gnugrep}/bin/grep --quiet "^${cfg.incus.image},"; then
          echo "Incus image ${cfg.incus.image} already exists"
          exit 0
        fi
        exec ${cfg.package}/bin/agentslave-incus-image
      '';
      serviceConfig = serviceHardening // {
        Type = "oneshot";
        StateDirectory = "agentslave";
        TimeoutStartSec = "30min";
      };
    };

    systemd.services.agentslave-incus-reaper = lib.mkIf cfg.incus.enable {
      description = "Remove expired AgentSlave Incus instances";
      after = [ "incus.service" ];
      requires = [ "incus.service" ];
      environment = commonEnvironment;
      path = [ config.virtualisation.incus.clientPackage ];
      script = ''
        now=$(${pkgs.coreutils}/bin/date +%s)
        cutoff=$((now - ${toString cfg.incus.maxAgeSeconds}))
        incus --project "${cfg.incus.project}" list --format json \
          | ${pkgs.jq}/bin/jq -r '.[] | select(.name | startswith("as-")) | [.name, .created_at] | @tsv' \
          | while IFS=$'\t' read -r name created_at; do
              created_epoch=$(${pkgs.coreutils}/bin/date --date="$created_at" +%s 2>/dev/null || true)
              if [ -n "$created_epoch" ] && [ "$created_epoch" -le "$cutoff" ]; then
                echo "Deleting expired Incus instance $name (created $created_at)"
                incus --project "${cfg.incus.project}" delete --force "$name"
              fi
            done
      '';
      serviceConfig = serviceHardening // {
        Type = "oneshot";
      };
    };

    systemd.timers.agentslave-incus-reaper = lib.mkIf cfg.incus.enable {
      description = "Enforce the AgentSlave Incus instance lifetime limit";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = cfg.incus.reapInterval;
        OnUnitActiveSec = cfg.incus.reapInterval;
        RandomizedDelaySec = "30s";
        Persistent = true;
      };
    };

    systemd.services.agentslave = {
      description = "AgentSlave orchestration service";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "postgresql.service"
        "agentslave-migrate.service"
      ]
      ++ lib.optionals cfg.incus.enable [ "incus.service" ]
      ++ lib.optionals (cfg.incus.enable && cfg.incus.buildImage) [ "agentslave-incus-image.service" ];
      wants = [ "network-online.target" ];
      requires = [
        "postgresql.service"
        "agentslave-migrate.service"
      ]
      ++ lib.optionals cfg.incus.enable [ "incus.service" ]
      ++ lib.optionals (cfg.incus.enable && cfg.incus.buildImage) [ "agentslave-incus-image.service" ];
      path = lib.optional cfg.incus.enable config.virtualisation.incus.clientPackage;
      environment = commonEnvironment;
      serviceConfig = serviceHardening // {
        ExecStart = "${cfg.package}/bin/agentslave";
        Restart = "on-failure";
        RestartSec = "3s";
        StateDirectory = "agentslave";
        UMask = "0027";
      };
    };
  };
}
