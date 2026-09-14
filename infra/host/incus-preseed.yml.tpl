networks:
  - name: incusbr0
    type: bridge
    config:
      ipv4.address: 10.0.0.1/24
      ipv6.address: none
storage_pools:
  - name: homehost
    driver: zfs
    config:
      size: @POOL_SIZE@
      source: /var/lib/incus/disks/homehost.img
profiles:
  - name: default
    devices:
      root:
        path: /
        pool: homehost
        type: disk
      eth0:
        name: eth0
        network: incusbr0
        type: nic
cluster: null
