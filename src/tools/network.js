import {
    listNetworks as fetchNetworks,
    getNetwork as fetchNetwork,
    createNetwork as apiCreateNetwork,
    deleteNetwork as apiDeleteNetwork,
    listSubnets as fetchSubnets,
    createSubnet as apiCreateSubnet,
    deleteSubnet as apiDeleteSubnet
} from '../vhi/network.js';
import { resolveId } from './resolver.js';

export async function listNetworks(args = {}) {
    const networks = await fetchNetworks();
    return {
        count: (networks || []).length,
        networks: (networks || []).map(n => ({
            name: n.name,
            status: n.status,
            id: n.id,
        })),
    };
}

export async function getNetwork(args) {
    const networkId = await resolveId('network', args.network_id);
    if (!networkId) throw new Error('network_id required');
    const network = await fetchNetwork(networkId);
    if (!network) return { found: false, network_id: networkId };
    return { found: true, network };
}

export async function createNetwork(args) {
    if (!args.name) throw new Error('name required');
    const network = await apiCreateNetwork(args);
    return { ok: true, action: 'create_network', network_id: network.id, network };
}

export async function deleteNetwork(args) {
    const networkId = await resolveId('network', args.network_id);
    if (!networkId) throw new Error('network_id required');
    await apiDeleteNetwork(networkId);
    return { ok: true, action: 'delete_network', network_id: networkId };
}

export async function listSubnets(args = {}) {
    const networkId = await resolveId('network', args.network_id);
    const subnets = await fetchSubnets({ network_id: networkId });
    return {
        count: (subnets || []).length,
        subnets: (subnets || []).map(s => ({
            id: s.id,
            name: s.name,
            network_id: s.network_id,
            cidr: s.cidr,
            gateway_ip: s.gateway_ip
        })),
    };
}

export async function createSubnet(args) {
    const networkId = await resolveId('network', args.network_id);
    if (!networkId || !args.cidr) throw new Error('network_id and cidr required');
    const subnetParams = {
        network_id: networkId,
        cidr: args.cidr,
        ip_version: args.ip_version || 4,
    };
    if (args.name) subnetParams.name = args.name;

    const subnet = await apiCreateSubnet(subnetParams);
    return { ok: true, action: 'create_subnet', subnet_id: subnet.id, subnet };
}

export async function deleteSubnet(args) {
    const subnetId = await resolveId('subnet', args.subnet_id);
    if (!subnetId) throw new Error('subnet_id required');
    await apiDeleteSubnet(subnetId);
    return { ok: true, action: 'delete_subnet', subnet_id: subnetId };
}
