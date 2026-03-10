/**
 * Network tools – list, get, create, delete for networks and subnets
 */

import {
    listNetworks as fetchNetworks,
    getNetwork as fetchNetwork,
    createNetwork as apiCreateNetwork,
    deleteNetwork as apiDeleteNetwork,
    listSubnets as fetchSubnets,
    createSubnet as apiCreateSubnet,
    deleteSubnet as apiDeleteSubnet
} from '../vhi/network.js';

export async function listNetworks(args = {}) {
    const networks = await fetchNetworks();
    return {
        count: (networks || []).length,
        networks: (networks || []).map(n => ({
            id: n.id,
            name: n.name,
            status: n.status,
        })),
    };
}

export async function getNetwork(args) {
    if (!args.network_id) throw new Error('network_id required');
    const network = await fetchNetwork(args.network_id);
    if (!network) return { found: false, network_id: args.network_id };
    return { found: true, network };
}

export async function createNetwork(args) {
    if (!args.name) throw new Error('name required');
    const network = await apiCreateNetwork(args);
    return { ok: true, action: 'create_network', network_id: network.id, network };
}

export async function deleteNetwork(args) {
    if (!args.network_id) throw new Error('network_id required');
    await apiDeleteNetwork(args.network_id);
    return { ok: true, action: 'delete_network', network_id: args.network_id };
}

export async function listSubnets(args = {}) {
    const subnets = await fetchSubnets({ network_id: args.network_id });
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
    if (!args.network_id || !args.cidr) throw new Error('network_id and cidr required');
    const subnetParams = {
        network_id: args.network_id,
        cidr: args.cidr,
        ip_version: args.ip_version || 4,
    };
    if (args.name) subnetParams.name = args.name;

    const subnet = await apiCreateSubnet(subnetParams);
    return { ok: true, action: 'create_subnet', subnet_id: subnet.id, subnet };
}

export async function deleteSubnet(args) {
    if (!args.subnet_id) throw new Error('subnet_id required');
    await apiDeleteSubnet(args.subnet_id);
    return { ok: true, action: 'delete_subnet', subnet_id: args.subnet_id };
}
