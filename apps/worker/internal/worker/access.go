package worker

import (
	"crypto/rand"
	"encoding/base64"
	"strings"
)

var ipv6DNS = []string{"2606:4700:4700::1111", "2001:4860:4860::8888"}

// newPassword is 18 random bytes as base64url: shell- and YAML-safe.
func newPassword() string {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// gatewayOf is the routed prefix's ::ffff, mirrored by infra/host/homehost-brnet.sh.
func gatewayOf(prefix string) string {
	return strings.TrimRight(prefix, ":") + "::ffff"
}

func buildNetConfig(ipv6, gateway string) string {
	return `version: 2
ethernets:
  lan:
    match:
      name: "e*"
    dhcp4: true
    dhcp6: false
    addresses: [` + ipv6 + `/64]
    routes:
      - to: "::/0"
        via: ` + gateway + `
    nameservers:
      addresses: [` + strings.Join(ipv6DNS, ", ") + `]
`
}

func yamlSingle(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// buildUserData is the VM cloud-config: a generated root password (one
// dashboard read, then cleared) plus the owner's key when provided.
// Passwords are base64url so the whole `user:pass` scalar survives YAML
// single-quoting. openssh-server is baked into the image, so first boot
// runs no apt; the apt conf only serves later recipe installs.
func buildUserData(sshPubkey, password string) string {
	keys := ""
	if sshPubkey != "" {
		keys = "users:\n  - name: root\n    ssh_authorized_keys:\n      - " + yamlSingle(sshPubkey) + "\n"
	}
	return `#cloud-config
manage_etc_hosts: true
apt:
  conf: |
    Acquire::ForceIPv4 "true";
` + keys + `chpasswd:
  list:
    - ` + yamlSingle("root:"+password) + `
  expire: false
ssh_pwauth: true
write_files:
  - path: /etc/ssh/sshd_config.d/60-homehost.conf
    content: |
      PermitRootLogin yes
      PasswordAuthentication yes
runcmd:
  - systemctl restart ssh
`
}

// containerSSHScript configures the baked sshd in a running container
// (containers ignore cloud-init), run fail-fast with `sh -euc`. The image
// ships without host keys, so each box generates its own here. The password is
// base64url (shell-safe); the pubkey travels base64-encoded so key comments
// can never break quoting. With containerIPv6 set, the static v6 is
// configured in-guest: incusbr0 rejects a live NIC override.
func containerSSHScript(password, sshPubkey, containerIPv6, prefix string) string {
	keySetup := ""
	if sshPubkey != "" {
		encoded := base64.StdEncoding.EncodeToString([]byte(sshPubkey))
		keySetup = "mkdir -p /root/.ssh\nchmod 700 /root/.ssh\necho '" + encoded + "' | base64 -d > /root/.ssh/authorized_keys\nchmod 600 /root/.ssh/authorized_keys\n"
	}
	v6Setup := ""
	if containerIPv6 != "" {
		gateway := gatewayOf(prefix)
		netplan := "network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n      dhcp6: false\n      addresses: [" + containerIPv6 + "/64]\n      routes:\n        - to: \"::/0\"\n          via: \"" + gateway + "\"\n      nameservers:\n        addresses: [" + strings.Join(ipv6DNS, ", ") + "]\n"
		v6Setup = "mkdir -p /etc/netplan\ncat > /etc/netplan/60-homehost-v6.yaml <<'HOMEHOST_EOF'\n" + netplan + "HOMEHOST_EOF\nif command -v netplan >/dev/null 2>&1; then netplan apply; else # No netplan: live-only addresses, lost on reboot.\nip -6 addr add " + containerIPv6 + "/64 dev eth0 2>/dev/null || true\nip -6 route add default via " + gateway + " dev eth0 2>/dev/null || true\nfi\n"
	}
	return "ssh-keygen -A\nmkdir -p /etc/ssh/sshd_config.d\nprintf 'PermitRootLogin yes\\nPasswordAuthentication yes\\n' > /etc/ssh/sshd_config.d/60-homehost.conf\n" + keySetup + v6Setup + "printf '%s\\n' 'root:" + password + "' | chpasswd\nsystemctl enable --now ssh\n"
}
