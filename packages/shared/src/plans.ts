export type DesktopEnv = "ubuntu-xfce" | "omarchy";

/** KasmVNC desktop baked into a GUI VM plan. `user` is the guest login the
 * Kasm password is minted for (ubuntu-xfce: `ubuntu`, omarchy: `omarchy`):
 * the panel login page hardcodes it and asks only for the OTP. */
export interface DesktopConfig {
  env: DesktopEnv;
  /** Guest username owning the KasmVNC session (per-env, not always ubuntu). */
  user: string;
  /** X display the VNC server binds, e.g. ":5". */
  display: string;
  /** KasmVNC websocket port serving the browser canvas. */
  kasmPort: number;
  /** Raw VNC port (loopback-only, never routed). */
  vncPort: number;
  /** Public-facing web port on the guest (equals kasmPort). */
  webPort: number;
}

export interface Plan {
  id: string;
  name: string;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  /** Requires the technical friend tier; every request still needs approval. */
  technicalOnly: boolean;
  /** False when the worker cannot provision this plan yet. */
  available: boolean;
  /** Stable code explaining `available: false`. */
  unavailableReason?: "installer_unavailable";
  /** Tenant unit: shared-kernel container or full KVM virtual machine. */
  kind: "container" | "vm";
  /** Incus image alias the worker launches from: a homehost-baked image
   * (infra/host/build-images.sh) in the default project, e.g.
   * homehost/ubuntu-24.04/vm. Omarchy keeps its upstream alias (never launched). */
  image: string;
  /** Present only on GUI desktop plans; controls the KasmVNC bake. */
  desktop?: DesktopConfig;
  /** Shares the host's NVIDIA GPU, time-sliced with every other GPU box.
   * Containers only: a VM would take the whole card from the host. */
  gpu?: boolean;
}

export const PLANS: Plan[] = [
  {
    id: "container-small",
    name: "Container Small",
    cpu: 2,
    memoryMb: 2048,
    diskGb: 20,
    technicalOnly: false,
    available: true,
    kind: "container",
    image: "homehost/ubuntu-24.04/container",
  },
  {
    id: "container-gpu",
    name: "Container GPU",
    cpu: 4,
    memoryMb: 4096,
    diskGb: 40,
    technicalOnly: true,
    available: true,
    kind: "container",
    image: "homehost/ubuntu-24.04/container",
    gpu: true,
  },
  {
    id: "vm-medium",
    name: "VM Medium",
    cpu: 4,
    memoryMb: 4096,
    diskGb: 40,
    technicalOnly: true,
    available: true,
    kind: "vm",
    image: "homehost/ubuntu-24.04/vm",
  },
  {
    id: "vm-large",
    name: "VM Large",
    cpu: 8,
    memoryMb: 8192,
    diskGb: 80,
    technicalOnly: true,
    available: true,
    kind: "vm",
    image: "homehost/ubuntu-24.04/vm",
  },
  {
    id: "desktop-ubuntu",
    name: "Desktop Ubuntu",
    cpu: 2,
    memoryMb: 2048,
    diskGb: 20,
    technicalOnly: true,
    available: true,
    kind: "vm",
    image: "homehost/ubuntu-24.04/desktop-xfce",
    desktop: {
      env: "ubuntu-xfce",
      user: "ubuntu",
      display: ":5",
      kasmPort: 6090,
      vncPort: 5905,
      webPort: 6090,
    },
  },
  {
    id: "desktop-omarchy",
    name: "Desktop Omarchy",
    cpu: 4,
    memoryMb: 4096,
    diskGb: 40,
    technicalOnly: true,
    // The worker fails it closed (omarchyUnavailable): no non-interactive installer.
    available: false,
    unavailableReason: "installer_unavailable",
    kind: "vm",
    image: "images:archlinux/cloud",
    desktop: {
      env: "omarchy",
      user: "omarchy",
      display: ":5",
      kasmPort: 6090,
      vncPort: 5905,
      webPort: 6090,
    },
  },
];
