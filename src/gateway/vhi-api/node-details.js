/**
 * Normalize vinfra / Nova node payloads and optional DMI inventory
 * so the UI always receives arrays and consistent hardware fields.
 */

function asList(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof value === 'object') {
    return Object.keys(value).filter((k) => value[k] !== false && value[k] != null);
  }
  return [String(value)];
}

export function normalizeRoles(roles) {
  return asList(roles).map((r) => {
    if (typeof r === 'string') return r;
    return r?.name || r?.role || r?.id || String(r);
  });
}

export function normalizeServices(services) {
  if (services == null || services === '') return [];
  if (Array.isArray(services)) {
    return services.map((s) => {
      if (typeof s === 'string') return { name: s, status: 'unknown' };
      return {
        name: s.name || s.service || s.id || 'service',
        status: s.status || s.state || 'unknown',
      };
    });
  }
  if (typeof services === 'object') {
    return Object.entries(services).map(([name, val]) => ({
      name,
      status: typeof val === 'string' ? val : (val?.status || val?.state || 'unknown'),
    }));
  }
  return [];
}

function oneDisk(d) {
  if (d == null) return null;
  if (typeof d === 'string') return { name: d, size: 0, model: '', serial: '', vendor: '', role: '', transport: '' };
  if (typeof d !== 'object') return null;
  return {
    name: d.name || d.device || d.dev || d.id || 'disk',
    model: d.model || d.device_model || '',
    serial: d.serial || d.serial_number || '',
    vendor: d.vendor || d.manufacturer || '',
    size: Number(d.size || d.capacity || d.size_bytes || d.capacity_bytes || 0),
    role: d.role || d.type || d.used_for || d.used || '',
    transport: d.transport || d.interface || d.bus || d.tran || '',
  };
}

export function normalizeDisks(disks) {
  if (disks == null || disks === '') return [];
  if (Array.isArray(disks)) return disks.map(oneDisk).filter(Boolean);
  if (typeof disks === 'object') return Object.values(disks).map(oneDisk).filter(Boolean);
  return [];
}

export function parseCpuInfo(cpuInfo) {
  let info = cpuInfo;
  if (!info) return {};
  if (typeof info === 'string') {
    try { info = JSON.parse(info); } catch (_) { return { model: info }; }
  }
  if (typeof info !== 'object') return {};
  const topo = info.topology || {};
  return {
    arch: info.arch || '',
    model: info.model || '',
    vendor: info.vendor || '',
    cores: Number(topo.cores) || 0,
    threads: Number(topo.threads) || 0,
    sockets: Number(topo.sockets) || 0,
  };
}

function dmiGrab(text, label) {
  const m = String(text || '').match(new RegExp('^\\s*' + label + ':\\s*(.+)$', 'im'));
  const val = m ? m[1].trim() : '';
  if (!val || /^(not specified|unknown|none|to be filled|n\/a)$/i.test(val)) return '';
  return val;
}

export function parseDmiSystem(text) {
  return {
    manufacturer: dmiGrab(text, 'Manufacturer'),
    product: dmiGrab(text, 'Product Name'),
    serial: dmiGrab(text, 'Serial Number'),
    sku: dmiGrab(text, 'SKU Number'),
    uuid: dmiGrab(text, 'UUID'),
    family: dmiGrab(text, 'Family'),
    version: dmiGrab(text, 'Version'),
  };
}

export function parseDmiBios(text) {
  return {
    vendor: dmiGrab(text, 'Vendor'),
    version: dmiGrab(text, 'Version'),
    date: dmiGrab(text, 'Release Date'),
  };
}

export function parseDmiProcessors(text) {
  const blocks = String(text || '').split(/Processor Information/i).slice(1);
  return blocks.map((b) => ({
    manufacturer: dmiGrab(b, 'Manufacturer'),
    version: dmiGrab(b, 'Version'),
    family: dmiGrab(b, 'Family'),
    cores: dmiGrab(b, 'Core Count'),
    threads: dmiGrab(b, 'Thread Count'),
    maxSpeed: dmiGrab(b, 'Max Speed'),
    currentSpeed: dmiGrab(b, 'Current Speed'),
    socket: dmiGrab(b, 'Socket Designation'),
  })).filter((p) => p.version || p.manufacturer);
}

export function parseDmiMemory(text) {
  const blocks = String(text || '').split(/Memory Device/i).slice(1);
  const modules = [];
  for (const b of blocks) {
    const size = dmiGrab(b, 'Size');
    if (!size || /no module|not installed|unknown|0 mb/i.test(size)) continue;
    modules.push({
      size,
      type: dmiGrab(b, 'Type'),
      speed: dmiGrab(b, 'Speed'),
      locator: dmiGrab(b, 'Locator'),
      manufacturer: dmiGrab(b, 'Manufacturer'),
      part: dmiGrab(b, 'Part Number'),
    });
  }
  return modules;
}

function flattenLsblk(devices, parent = '') {
  const out = [];
  for (const d of devices || []) {
    const name = d.name || '';
    const full = parent ? parent + '/' + name : name;
    if (String(d.type || '') === 'disk') {
      out.push({
        name,
        model: d.model || '',
        serial: d.serial || '',
        vendor: d.vendor || '',
        size: Number(d.size) || 0,
        role: d.rota === true || d.rota === '1' ? 'HDD' : (d.rota === false || d.rota === '0' ? 'SSD/NVMe' : ''),
        transport: d.tran || '',
      });
    }
    if (Array.isArray(d.children)) out.push(...flattenLsblk(d.children, full));
  }
  return out;
}

export function applySshInventory(node, results) {
  const [systemRaw, biosRaw, procRaw, memRaw, lsblkRaw] = results || [];
  const system = parseDmiSystem(systemRaw);
  const bios = parseDmiBios(biosRaw);
  const processors = parseDmiProcessors(procRaw);
  const modules = parseDmiMemory(memRaw);

  if (system.manufacturer) node.system_vendor = node.system_vendor || system.manufacturer;
  if (system.product) node.system_product = node.system_product || system.product;
  if (system.serial) node.system_serial = node.system_serial || system.serial;
  if (system.sku) node.system_sku = node.system_sku || system.sku;
  if (system.uuid) node.system_uuid = node.system_uuid || system.uuid;
  if (bios.vendor || bios.version) {
    node.bios_vendor = node.bios_vendor || bios.vendor;
    node.bios_version = node.bios_version || bios.version;
    node.bios_date = node.bios_date || bios.date;
  }
  if (processors.length) {
    const first = processors[0];
    node.cpu_vendor = node.cpu_vendor || first.manufacturer;
    node.cpu_model = node.cpu_model || first.version;
    node.cpu_sockets = node.cpu_sockets || processors.length;
    node.cpu_cores = node.cpu_cores || Number(first.cores) || 0;
    node.cpu_threads = node.cpu_threads || Number(first.threads) || 0;
    node.cpu_speed = node.cpu_speed || first.currentSpeed || first.maxSpeed;
    node.processors = processors;
  }
  if (modules.length) {
    node.memory_modules = modules;
    node.memory_module_count = modules.length;
  }

  let lsblk = lsblkRaw;
  if (typeof lsblk === 'string') {
    try { lsblk = JSON.parse(lsblk); } catch (_) { lsblk = null; }
  }
  const physical = flattenLsblk(lsblk && lsblk.blockdevices);
  if (physical.length && !(node.disks && node.disks.length)) {
    node.disks = physical;
  } else if (physical.length) {
    const byName = new Map(node.disks.map((d) => [String(d.name || '').replace(/^\/dev\//, ''), d]));
    for (const disk of physical) {
      const key = String(disk.name || '').replace(/^\/dev\//, '');
      const existing = byName.get(key);
      if (existing) {
        existing.model = existing.model || disk.model;
        existing.serial = existing.serial || disk.serial;
        existing.vendor = existing.vendor || disk.vendor;
        existing.size = existing.size || disk.size;
        existing.transport = existing.transport || disk.transport;
        existing.role = existing.role || disk.role;
      } else {
        node.disks.push(disk);
      }
    }
  }
  return node;
}

export function mergeHypervisorIntoNode(node, hv) {
  if (!hv) return node;
  const cpu = parseCpuInfo(hv.cpu_info);
  node.hypervisor_id = hv.id;
  node.hypervisor_type = node.hypervisor_type || hv.hypervisor_type;
  node.hypervisor_version = hv.hypervisor_version;
  node.hypervisor_hostname = node.hypervisor_hostname || hv.hypervisor_hostname;
  node.host_ip = node.host_ip || hv.host_ip;
  node.vcpus = hv.vcpus;
  node.vcpus_used = hv.vcpus_used;
  node.memory_mb = hv.memory_mb;
  node.free_ram_mb = hv.free_ram_mb;
  node.local_gb = hv.local_gb;
  node.free_disk_gb = hv.free_disk_gb;
  node.running_vms = hv.running_vms;
  node.cpu_arch = node.cpu_arch || cpu.arch;
  node.cpu_vendor = node.cpu_vendor || cpu.vendor;
  node.cpu_model = node.cpu_model || cpu.model;
  node.cpu_sockets = node.cpu_sockets || cpu.sockets;
  node.cpu_cores = node.cpu_cores || cpu.cores;
  node.cpu_threads = node.cpu_threads || cpu.threads;
  if (!node.ram_size && hv.memory_mb) node.ram_size = hv.memory_mb * 1024 * 1024;
  if (!node.cpus && hv.vcpus) node.cpus = hv.vcpus;
  return node;
}

export function normalizeNodeDetails(raw) {
  const node = raw && typeof raw === 'object' ? { ...raw } : {};
  node.id = node.id || node.uuid || '';
  node.hostname = node.hostname || node.host || node.name || node.orig_hostname || node.hypervisor_hostname || node.id;
  node.name = node.name || node.hostname;
  node.status = node.status || 'unknown';
  if (!node.state) {
    node.state = node.is_online === false ? 'down' : (node.is_online ? 'up' : 'unknown');
  }
  node.roles = normalizeRoles(node.roles);
  node.services = normalizeServices(node.services);
  node.disks = normalizeDisks(node.disks);
  node.networks = Array.isArray(node.networks) ? node.networks : [];

  node.system_vendor = node.system_vendor || node.manufacturer || node.system_manufacturer || node.vendor || '';
  node.system_product = node.system_product || node.product_name || node.system_model || node.model || '';
  node.system_serial = node.system_serial || node.serial || node.serial_number || node.chassis_serial || '';
  node.bios_version = node.bios_version || node.bios || '';
  node.cpu_model = node.cpu_model || node.cpu || '';
  node.cpus = Number(node.cpus || node.cpu_count || node.vcpus) || 0;
  if (node.ram_size && node.ram_size < 1048576 && node.memory_mb) {
    node.ram_size = node.memory_mb * 1024 * 1024;
  }
  return node;
}

export { asList };
