import { listServers, listHypervisors } from '../vhi/compute.js';
import { listVolumes } from '../vhi/block.js';

export async function calculateHourlyConsumption() {
  console.log('[Billing] Calculating hourly consumption (Hypervisor-aware)...');
  
  let totalVcpus = 0;
  let totalRamMb = 0; 
  let totalStorageGb = 0;
  let totalVms = 0;

  try {
    // 1. Fetch Hypervisor details for 100% accurate cluster-wide allocation (vCPU/RAM)
    // This matches the "Node Health" dashboard and includes all VM overhead.
    const hypervisors = await listHypervisors().catch(() => []);
    console.log(`[Billing] Found ${hypervisors.length} hypervisors.`);
    
    for (const h of hypervisors) {
      const usedVcpu = h.vcpus_used || 0;
      const usedRam = (h.memory_mb || 0) - (h.free_ram_mb || 0);
      const vms = h.running_vms || 0;
      
      totalVcpus += usedVcpu;
      totalRamMb += usedRam;
      totalVms += vms;
    }
    console.log(`[Billing] TOTAL ALLOCATION: vCPUs=${totalVcpus}, RAM=${totalRamMb} MB, VMs=${totalVms}`);

    // 2. Fetch all volumes for storage allocation
    const volumes = await listVolumes().catch(() => []);
    console.log(`[Billing] Found ${volumes.length} volumes total.`);
    for (const v of volumes) {
      if (v.status !== 'deleting' && v.status !== 'error_deleting') {
        totalStorageGb += (v.size || 0);
      }
    }
    console.log(`[Billing] TOTAL STORAGE: ${totalStorageGb} GB`);

  } catch (err) {
    console.error('[Billing] Failed to calculate consumption:', err);
  }

  // 3. Network Traffic (Mocked placeholder)
  const txGB = (Math.random() * 5 + 1).toFixed(2);
  const rxGB = (Math.random() * 15 + 2).toFixed(2);
  const networkS = `${txGB} GB Tx / ${rxGB} GB Rx`;

  return {
    vCpu: totalVcpus,
    ramGb: (totalRamMb / 1024).toFixed(1),
    storageGb: totalStorageGb,
    networkTraffic: networkS,
    timestamp: new Date().toISOString()
  };
}
