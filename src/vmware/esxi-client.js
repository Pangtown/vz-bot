/**
 * Direct VMware ESXi & vCenter Client (VDDK Bypass)
 *
 * Connects directly to vSphere Web Services SOAP API (https://<host>:<port>/sdk)
 * and native HTTPS datastore/NFC endpoints without requiring Broadcom's restricted
 * VDDK binaries or proprietary SDKs.
 */

import { registerInsecureHost } from '../utils/tls.js';
import { logger } from '../utils/index.js';
import { createWriteStream } from 'fs';
import { Client } from 'ssh2';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

/** Escape XML special characters */
function escapeXml(unsafe) {
  if (typeof unsafe !== 'string') return String(unsafe ?? '');
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Extract simple tag content from XML string */
function getTagContent(xml, tagName) {
  const regex = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

/** Extract all tag blocks */
function getAllTagBlocks(xml, tagName) {
  const regex = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${tagName}>`, 'gi');
  const blocks = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

/**
 * Send a SOAP request to the vSphere /sdk endpoint
 */
async function sendSoapRequest({ url, soapAction = 'urn:vim25/6.0', body, cookie = null }) {
  const headers = {
    'Content-Type': 'text/xml; charset=utf-8',
    'SOAPAction': `"${soapAction}"`,
  };
  if (cookie) {
    headers['Cookie'] = cookie;
  }

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:vim25="urn:vim25">
  <soapenv:Body>
    ${body}
  </soapenv:Body>
</soapenv:Envelope>`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: envelope,
  });

  const responseText = await res.text();
  const setCookie = res.headers.get('set-cookie');

  if (!res.ok) {
    const faultString = getTagContent(responseText, 'faultstring') || `HTTP Error ${res.status}: ${res.statusText}`;
    const faultDetail = getTagContent(responseText, 'detail');
    const err = new Error(faultString);
    err.statusCode = res.status;
    err.detail = faultDetail;
    throw err;
  }

  return { text: responseText, cookie: setCookie || cookie };
}

/**
 * Retrieve ServiceContent from ESXi / vCenter
 */
async function retrieveServiceContent(sdkUrl) {
  const body = `
    <vim25:RetrieveServiceContent>
      <vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this>
    </vim25:RetrieveServiceContent>
  `;
  const { text } = await sendSoapRequest({ url: sdkUrl, body });

  const rootFolder = getTagContent(text, 'rootFolder');
  const propertyCollector = getTagContent(text, 'propertyCollector');
  const viewManager = getTagContent(text, 'viewManager');
  const sessionManager = getTagContent(text, 'sessionManager');

  // Parse <about> block
  const aboutBlock = getTagContent(text, 'about') || '';
  const fullName = getTagContent(aboutBlock, 'fullName') || 'VMware ESXi';
  const name = getTagContent(aboutBlock, 'name') || 'VMware ESXi';
  const version = getTagContent(aboutBlock, 'version') || '';
  const build = getTagContent(aboutBlock, 'build') || '';
  const apiType = getTagContent(aboutBlock, 'apiType') || 'HostAgent'; // HostAgent (ESXi) or VirtualCenter (vCenter)
  const apiVersion = getTagContent(aboutBlock, 'apiVersion') || '';

  return {
    rootFolder,
    propertyCollector,
    viewManager,
    sessionManager: sessionManager || 'SessionManager',
    about: {
      fullName,
      name,
      version,
      build,
      apiType,
      apiVersion,
      isVcenter: apiType === 'VirtualCenter',
    }
  };
}

/**
 * Authenticate session on ESXi / vCenter
 */
async function login({ sdkUrl, sessionManager, username, password }) {
  const body = `
    <vim25:Login>
      <vim25:_this type="SessionManager">${escapeXml(sessionManager)}</vim25:_this>
      <vim25:userName>${escapeXml(username)}</vim25:userName>
      <vim25:password>${escapeXml(password)}</vim25:password>
    </vim25:Login>
  `;
  const { text, cookie } = await sendSoapRequest({ url: sdkUrl, body });

  const userSession = getTagContent(text, 'returnval');
  const sessionKey = getTagContent(userSession || text, 'key');
  const loggedInUser = getTagContent(userSession || text, 'userName') || username;

  return { sessionKey, cookie, loggedInUser };
}

/**
 * Logout session on ESXi / vCenter
 */
async function logout({ sdkUrl, sessionManager, cookie }) {
  if (!cookie) return;
  try {
    const body = `
      <vim25:Logout>
        <vim25:_this type="SessionManager">${escapeXml(sessionManager)}</vim25:_this>
      </vim25:Logout>
    `;
    await sendSoapRequest({ url: sdkUrl, body, cookie });
  } catch (err) {
    logger.debug(`ESXi logout warning: ${err.message}`);
  }
}

/**
 * Test & validate connection to an ESXi / vCenter server
 *
 * @param {Object} opts
 * @param {string} opts.host - IP or hostname of ESXi / vCenter
 * @param {number} [opts.port=443] - Port (default 443)
 * @param {string} opts.username - Username (e.g. root or user@vsphere.local)
 * @param {string} opts.password - Password
 * @param {boolean} [opts.insecure=true] - Accept self-signed TLS certificates
 * @returns {Promise<Object>} Status, version, build, apiType
 */
export async function testEsxiConnection({ host, port = 443, username, password, insecure = true }) {
  if (!host) throw new Error('Host is required');
  if (!username) throw new Error('Username is required');
  if (!password) throw new Error('Password is required');

  const cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const sdkUrl = `https://${cleanHost}:${port || 443}/sdk`;

  if (insecure) {
    registerInsecureHost(sdkUrl);
  }

  logger.info(`Validating connection to ESXi server: ${sdkUrl} (user: ${username})`);

  try {
    // 1. Retrieve Service Content (API version, sessionManager)
    const content = await retrieveServiceContent(sdkUrl);

    // 2. Perform Login with provided credentials
    const auth = await login({
      sdkUrl,
      sessionManager: content.sessionManager,
      username,
      password,
    });

    // 3. Graceful Logout
    await logout({
      sdkUrl,
      sessionManager: content.sessionManager,
      cookie: auth.cookie,
    });

    return {
      ok: true,
      host: cleanHost,
      port: Number(port) || 443,
      serverInfo: content.about,
      message: `Successfully connected to ${content.about.fullName} (${content.about.apiType})`,
    };
  } catch (err) {
    logger.warn(`ESXi connection failed for ${sdkUrl}: ${err.message}`);
    let humanError = err.message;
    if (err.message.includes('incorrect user name or password') || (err.detail && err.detail.includes('InvalidLogin'))) {
      humanError = 'Authentication failed: Incorrect username or password.';
    } else if (err.code === 'ECONNREFUSED' || err.message.includes('ECONNREFUSED')) {
      humanError = `Connection refused at ${cleanHost}:${port}. Please verify host IP and port.`;
    } else if (err.code === 'ETIMEDOUT' || err.message.includes('ETIMEDOUT')) {
      humanError = `Connection timed out connecting to ${cleanHost}:${port}. Check firewall or network routing.`;
    } else if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.message.includes('self signed certificate')) {
      humanError = 'Self-signed SSL certificate detected. Enable "Ignore SSL Certificate" to allow connection.';
    }
    return {
      ok: false,
      host: cleanHost,
      port: Number(port) || 443,
      error: humanError,
    };
  }
}

/**
 * Discover virtual machines and their resource specifications from ESXi / vCenter
 *
 * @param {Object} opts
 * @returns {Promise<Array<Object>>} List of discovered VMs with CPU, RAM, Disks, Networks
 */
export async function getEsxiVmInventory({ host, port = 443, username, password, insecure = true }) {
  const cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const sdkUrl = `https://${cleanHost}:${port || 443}/sdk`;

  if (insecure) {
    registerInsecureHost(sdkUrl);
  }

  const content = await retrieveServiceContent(sdkUrl);
  const auth = await login({
    sdkUrl,
    sessionManager: content.sessionManager,
    username,
    password,
  });

  try {
    // 1. Create a ContainerView for VirtualMachines
    const createViewBody = `
      <vim25:CreateContainerView>
        <vim25:_this type="ViewManager">${escapeXml(content.viewManager)}</vim25:_this>
        <vim25:container type="Folder">${escapeXml(content.rootFolder)}</vim25:container>
        <vim25:type>VirtualMachine</vim25:type>
        <vim25:recursive>true</vim25:recursive>
      </vim25:CreateContainerView>
    `;
    const viewRes = await sendSoapRequest({ url: sdkUrl, body: createViewBody, cookie: auth.cookie });
    const containerView = getTagContent(viewRes.text, 'returnval');

    if (!containerView) {
      throw new Error('Failed to create ContainerView on ESXi');
    }

    // 2. Retrieve Properties for VirtualMachines
    const retrievePropsBody = `
      <vim25:RetrievePropertiesEx>
        <vim25:_this type="PropertyCollector">${escapeXml(content.propertyCollector)}</vim25:_this>
        <vim25:specSet>
          <vim25:propSet>
            <vim25:type>VirtualMachine</vim25:type>
            <vim25:pathSet>name</vim25:pathSet>
            <vim25:pathSet>summary.runtime.powerState</vim25:pathSet>
            <vim25:pathSet>summary.config.numCpu</vim25:pathSet>
            <vim25:pathSet>summary.config.memorySizeMB</vim25:pathSet>
            <vim25:pathSet>summary.config.guestFullName</vim25:pathSet>
            <vim25:pathSet>summary.config.guestId</vim25:pathSet>
            <vim25:pathSet>config.hardware.device</vim25:pathSet>
            <vim25:pathSet>config.firmware</vim25:pathSet>
          </vim25:propSet>
          <vim25:objectSet>
            <vim25:obj type="ContainerView">${escapeXml(containerView)}</vim25:obj>
            <vim25:skip>true</vim25:skip>
            <vim25:selectSet xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="vim25:TraversalSpec">
              <vim25:name>traverseEntities</vim25:name>
              <vim25:type>ContainerView</vim25:type>
              <vim25:path>view</vim25:path>
              <vim25:skip>false</vim25:skip>
            </vim25:selectSet>
          </vim25:objectSet>
        </vim25:specSet>
        <vim25:options/>
      </vim25:RetrievePropertiesEx>
    `;

    const propsRes = await sendSoapRequest({ url: sdkUrl, body: retrievePropsBody, cookie: auth.cookie });

    // 3. Parse Objects from RetrievePropertiesEx
    const objects = getAllTagBlocks(propsRes.text, 'objects');
    const vms = [];

    for (const objXml of objects) {
      const vmObjTag = objXml.match(/<vim25:obj[^>]*type="VirtualMachine"[^>]*>([\s\S]*?)<\/vim25:obj>/i);
      const vmId = vmObjTag ? vmObjTag[1].trim() : (getTagContent(objXml, 'obj') || 'vm-unknown');

      const propSetBlocks = getAllTagBlocks(objXml, 'propSet');
      const props = {};

      for (const pBlock of propSetBlocks) {
        const name = getTagContent(pBlock, 'name');
        const valBlock = getTagContent(pBlock, 'val');
        if (name && valBlock !== null) {
          props[name] = { raw: valBlock, text: valBlock.replace(/<[^>]+>/g, '').trim() };
        }
      }

      const vmName = props['name']?.text || 'Unnamed VM';
      const powerState = props['summary.runtime.powerState']?.text || 'poweredOff';
      const numCpu = parseInt(props['summary.config.numCpu']?.text || '1', 10);
      const memoryMb = parseInt(props['summary.config.memorySizeMB']?.text || '1024', 10);
      const guestId = props['summary.config.guestId']?.text || '';
      const guestOs = props['summary.config.guestFullName']?.text || guestId || 'Other';
      const firmware = (props['config.firmware']?.text || 'bios').toLowerCase();

      // Parse Disks & Networks from config.hardware.device
      const devicesXml = props['config.hardware.device']?.raw || '';
      const deviceBlocks = getAllTagBlocks(devicesXml, 'VirtualDevice');

      const disks = [];
      const networks = [];

      for (const devXml of deviceBlocks) {
        const label = getTagContent(devXml, 'label') || '';
        if (devXml.includes('VirtualDisk') || label.toLowerCase().includes('hard disk')) {
          const capKb = parseInt(getTagContent(devXml, 'capacityInKB') || '0', 10);
          const backingBlock = getTagContent(devXml, 'backing') || '';
          const fileName = getTagContent(backingBlock, 'fileName') || '';
          const thin = backingBlock.includes('<vim25:thinProvisioned>true</vim25:thinProvisioned>');

          disks.push({
            label: label || `Disk ${disks.length + 1}`,
            capacityGb: Math.round(capKb / (1024 * 1024)) || 1,
            thinProvisioned: thin,
            backingFileName: fileName,
          });
        } else if (devXml.includes('VirtualEthernetCard') || label.toLowerCase().includes('network adapter')) {
          const mac = getTagContent(devXml, 'macAddress') || '';
          const backingBlock = getTagContent(devXml, 'backing') || '';
          const portgroup = getTagContent(backingBlock, 'deviceName') || 'VM Network';

          networks.push({
            label: label || `Adapter ${networks.length + 1}`,
            macAddress: mac,
            networkName: portgroup,
          });
        }
      }

      // Memory string formatting
      const ramStr = memoryMb >= 1024 ? `${(memoryMb / 1024).toFixed(0)} GB RAM` : `${memoryMb} MB RAM`;

      vms.push({
        id: vmId,
        name: vmName,
        powerState,
        vcpus: numCpu,
        ramMb: memoryMb,
        spec: `${numCpu} vCPU${numCpu > 1 ? 's' : ''} / ${ramStr}`,
        disksCount: disks.length || 1,
        disks: disks.length ? disks : [{ label: 'Hard disk 1', capacityGb: 20, thinProvisioned: true, backingFileName: '' }],
        networks,
        guestOs,
        guestId,
        firmware: firmware.includes('efi') ? 'uefi' : 'bios',
      });
    }

    return vms;
  } finally {
    await logout({
      sdkUrl,
      sessionManager: content.sessionManager,
      cookie: auth.cookie,
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function nfcLeaseAction(sdkUrl, cookie, leaseId, action, extra = '') {
  const body = `
    <vim25:${action}>
      <vim25:_this type="HttpNfcLease">${escapeXml(leaseId)}</vim25:_this>
      ${extra}
    </vim25:${action}>
  `;
  return sendSoapRequest({ url: sdkUrl, body, cookie });
}

async function retrieveNfcLease(sdkUrl, cookie, propertyCollector, leaseId) {
  const body = `
    <vim25:RetrievePropertiesEx>
      <vim25:_this type="PropertyCollector">${escapeXml(propertyCollector)}</vim25:_this>
      <vim25:specSet>
        <vim25:propSet>
          <vim25:type>HttpNfcLease</vim25:type>
          <vim25:all>true</vim25:all>
        </vim25:propSet>
        <vim25:objectSet>
          <vim25:obj type="HttpNfcLease">${escapeXml(leaseId)}</vim25:obj>
        </vim25:objectSet>
      </vim25:specSet>
      <vim25:options/>
    </vim25:RetrievePropertiesEx>
  `;
  const res = await sendSoapRequest({ url: sdkUrl, body, cookie });
  const xml = res.text || '';
  const state = (getTagContent(xml, 'state') || '').toLowerCase();
  const error = getTagContent(xml, 'error') || getTagContent(xml, 'localizedMessage') || '';
  const deviceBlocks = getAllTagBlocks(xml, 'deviceUrl');
  const disks = [];
  for (const block of deviceBlocks) {
    const url = getTagContent(block, 'url') || '';
    const isDisk = String(getTagContent(block, 'disk') || '').toLowerCase() === 'true' || /\.vmdk/i.test(url);
    if (!url || !isDisk) continue;
    disks.push({
      url,
      sslThumbprint: getTagContent(block, 'sslThumbprint') || '',
      targetId: getTagContent(block, 'targetId') || '',
    });
  }
  return { state, error, disks, xml };
}

function rewriteNfcUrl(url, host, port) {
  if (!url) return url;
  return url
    .replace('https://*', `https://${host}`)
    .replace('http://*', `http://${host}`)
    .replace(/https:\/\/\*:(\d+)/, `https://${host}:$1`)
    .replace(/:443\//, port && Number(port) !== 443 ? `:${port}/` : ':443/');
}

async function getVmPowerState(sdkUrl, cookie, propertyCollector, vmId) {
  const body = `
    <vim25:RetrievePropertiesEx>
      <vim25:_this type="PropertyCollector">${escapeXml(propertyCollector)}</vim25:_this>
      <vim25:specSet>
        <vim25:propSet>
          <vim25:type>VirtualMachine</vim25:type>
          <vim25:pathSet>runtime.powerState</vim25:pathSet>
        </vim25:propSet>
        <vim25:objectSet>
          <vim25:obj type="VirtualMachine">${escapeXml(vmId)}</vim25:obj>
        </vim25:objectSet>
      </vim25:specSet>
      <vim25:options/>
    </vim25:RetrievePropertiesEx>
  `;
  const res = await sendSoapRequest({ url: sdkUrl, body, cookie });
  const blocks = getAllTagBlocks(res.text, 'propSet');
  for (const block of blocks) {
    if (getTagContent(block, 'name') === 'runtime.powerState') {
      return String(getTagContent(block, 'val') || '').replace(/<[^>]+>/g, '').trim();
    }
  }
  return String(getTagContent(res.text, 'val') || getTagContent(res.text, 'powerState') || '').replace(/<[^>]+>/g, '').trim();
}

async function waitVimTask(sdkUrl, cookie, propertyCollector, taskId, { timeoutMs = 180000, label = 'task' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = `
      <vim25:RetrievePropertiesEx>
        <vim25:_this type="PropertyCollector">${escapeXml(propertyCollector)}</vim25:_this>
        <vim25:specSet>
          <vim25:propSet>
            <vim25:type>Task</vim25:type>
            <vim25:pathSet>info.state</vim25:pathSet>
            <vim25:pathSet>info.error</vim25:pathSet>
            <vim25:pathSet>info.result</vim25:pathSet>
          </vim25:propSet>
          <vim25:objectSet>
            <vim25:obj type="Task">${escapeXml(taskId)}</vim25:obj>
          </vim25:objectSet>
        </vim25:specSet>
        <vim25:options/>
      </vim25:RetrievePropertiesEx>
    `;
    const res = await sendSoapRequest({ url: sdkUrl, body, cookie });
    const xml = res.text || '';
    const props = {};
    for (const block of getAllTagBlocks(xml, 'propSet')) {
      const name = getTagContent(block, 'name');
      if (name) props[name] = getTagContent(block, 'val');
    }
    const state = String(props['info.state'] || getTagContent(xml, 'state') || '').toLowerCase();
    if (state.includes('success')) {
      const result = String(props['info.result'] || '').replace(/<[^>]+>/g, '').trim();
      return { state, result, xml };
    }
    if (state.includes('error')) {
      const errXml = String(props['info.error'] || '');
      const msg = getTagContent(errXml, 'localizedMessage') || getTagContent(xml, 'localizedMessage') || getTagContent(xml, 'faultstring') || 'vim task failed';
      throw new Error(`${label} failed: ${String(msg).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
    }
    await sleep(1500);
  }
  throw new Error(`${label} timed out`);
}

async function createVmSnapshot(sdkUrl, cookie, propertyCollector, vmId, name) {
  const body = `
    <vim25:CreateSnapshot_Task>
      <vim25:_this type="VirtualMachine">${escapeXml(vmId)}</vim25:_this>
      <vim25:name>${escapeXml(name)}</vim25:name>
      <vim25:description>vz-bot live migration disk snapshot</vim25:description>
      <vim25:memory>false</vim25:memory>
      <vim25:quiesce>false</vim25:quiesce>
    </vim25:CreateSnapshot_Task>
  `;
  const res = await sendSoapRequest({ url: sdkUrl, body, cookie });
  const taskId = getTagContent(res.text, 'returnval');
  if (!taskId) throw new Error('CreateSnapshot_Task did not return a task');
  const done = await waitVimTask(sdkUrl, cookie, propertyCollector, taskId, { timeoutMs: 300000, label: 'CreateSnapshot' });
  if (!done.result) throw new Error('CreateSnapshot succeeded but returned no snapshot id');
  return done.result;
}

async function removeVmSnapshot(sdkUrl, cookie, propertyCollector, snapshotId) {
  if (!sdkUrl || !cookie || !snapshotId) return;
  try {
    const body = `
      <vim25:RemoveSnapshot_Task>
        <vim25:_this type="VirtualMachineSnapshot">${escapeXml(snapshotId)}</vim25:_this>
        <vim25:removeChildren>false</vim25:removeChildren>
      </vim25:RemoveSnapshot_Task>
    `;
    const res = await sendSoapRequest({ url: sdkUrl, body, cookie });
    const taskId = getTagContent(res.text, 'returnval');
    if (taskId && propertyCollector) {
      await waitVimTask(sdkUrl, cookie, propertyCollector, taskId, { timeoutMs: 300000, label: 'RemoveSnapshot' });
    }
  } catch (err) {
    logger.warn(`RemoveSnapshot ${snapshotId} failed: ${err.message}`);
  }
}

async function exportNfcLease(sdkUrl, cookie, { vmId, snapshotId }) {
  const exportBody = snapshotId ? `
      <vim25:ExportSnapshot>
        <vim25:_this type="VirtualMachineSnapshot">${escapeXml(snapshotId)}</vim25:_this>
      </vim25:ExportSnapshot>
    ` : `
      <vim25:ExportVm>
        <vim25:_this type="VirtualMachine">${escapeXml(vmId)}</vim25:_this>
      </vim25:ExportVm>
    `;
  const res = await sendSoapRequest({ url: sdkUrl, body: exportBody, cookie });
  return getTagContent(res.text, 'returnval');
}
/**
 * Acquire an HTTP NFC lease and wait until disk URLs are ready.
 * Powered-on VMs are snapshotted and exported via ExportSnapshot (live).
 */
export async function acquireHttpNfcLease({ host, port = 443, username, password, insecure = true, vmId, live = false }) {
  const cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const sdkUrl = `https://${cleanHost}:${port || 443}/sdk`;

  if (insecure) {
    registerInsecureHost(sdkUrl);
    registerInsecureHost(`https://${cleanHost}`);
  }

  const content = await retrieveServiceContent(sdkUrl);
  const auth = await login({
    sdkUrl,
    sessionManager: content.sessionManager,
    username,
    password,
  });

  try {
    let snapshotId = null;
    let leaseId = null;
    try {
    const powerState = await getVmPowerState(sdkUrl, auth.cookie, content.propertyCollector, vmId);
    const running = /poweredOn/i.test(powerState);
    if (running) {
      const snapName = 'vzbot-live-' + Date.now();
      logger.info('Live NFC: creating snapshot ' + snapName + ' of powered-on VM ' + vmId);
      snapshotId = await createVmSnapshot(sdkUrl, auth.cookie, content.propertyCollector, vmId, snapName);
      leaseId = await exportNfcLease(sdkUrl, auth.cookie, { snapshotId });
      if (!leaseId) {
        throw new Error('ESXi ExportSnapshot did not return an HttpNfcLease. Live migration needs vSphere 6+ ExportSnapshot.');
      }
    } else {
      leaseId = await exportNfcLease(sdkUrl, auth.cookie, { vmId });
      if (!leaseId) {
        throw new Error('ESXi ExportVm did not return an HttpNfcLease. Power the VM off for a cold disk export, or use live snapshot export.');
      }
    }

    let info = { state: '', disks: [], error: '' };
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      info = await retrieveNfcLease(sdkUrl, auth.cookie, content.propertyCollector, leaseId);
      if (info.state.includes('error')) {
        throw new Error(`NFC lease error: ${info.error || 'unknown'}`);
      }
      if (info.state.includes('ready') && info.disks.length) break;
      await sleep(2000);
    }
    if (!info.disks.length) {
      throw new Error('NFC lease timed out before disk URLs were ready.');
    }

    const disks = info.disks.map((d) => ({
      ...d,
      url: rewriteNfcUrl(d.url, cleanHost, port),
    }));

    return {
      leaseId,
      snapshotId,
      sdkUrl,
      host: cleanHost,
      port: port || 443,
      cookie: auth.cookie,
      sessionManager: content.sessionManager,
      propertyCollector: content.propertyCollector,
      disks,
    };
    } catch (inner) {
      if (snapshotId) {
        await removeVmSnapshot(sdkUrl, auth.cookie, content.propertyCollector, snapshotId);
      }
      throw inner;
    }
  } catch (err) {
    await logout({
      sdkUrl,
      sessionManager: content.sessionManager,
      cookie: auth.cookie,
    });
    throw err;
  }
}

function shQuote(value) {
  return "'" + String(value ?? '').replace(/'/g, `'\\''`) + "'";
}

function parseVmdkFileName(fileName) {
  const m = String(fileName || '').match(/^\[([^\]]+)\]\s*(.+)$/);
  if (!m) return null;
  const datastore = m[1].trim();
  const relative = m[2].trim().replace(/\\/g, '/');
  if (!/\.vmdk$/i.test(relative) || /-flat\.vmdk$/i.test(relative) || /-delta\.vmdk$/i.test(relative) || /-sesparse\.vmdk$/i.test(relative)) {
    return null;
  }
  return {
    fileName: String(fileName).trim(),
    datastore,
    relative,
    vmfs: '/vmfs/volumes/' + datastore + '/' + relative,
  };
}

async function retrieveMoProps(sdkUrl, cookie, propertyCollector, type, moId, paths) {
  const pathXml = (paths || []).map((p) => `          <vim25:pathSet>${escapeXml(p)}</vim25:pathSet>`).join('\n');
  const body = `
    <vim25:RetrievePropertiesEx>
      <vim25:_this type="PropertyCollector">${escapeXml(propertyCollector)}</vim25:_this>
      <vim25:specSet>
        <vim25:propSet>
          <vim25:type>${escapeXml(type)}</vim25:type>
${pathXml}
        </vim25:propSet>
        <vim25:objectSet>
          <vim25:obj type="${escapeXml(type)}">${escapeXml(moId)}</vim25:obj>
        </vim25:objectSet>
      </vim25:specSet>
      <vim25:options/>
    </vim25:RetrievePropertiesEx>
  `;
  const res = await sendSoapRequest({ url: sdkUrl, body, cookie });
  return res.text || '';
}

function diskPathsFromXml(xml) {
  const names = getAllTagBlocks(xml, 'fileName') || [];
  const out = [];
  const seen = new Set();
  for (const raw of names) {
    const parsed = parseVmdkFileName(String(raw).replace(/<[^>]+>/g, '').trim());
    if (!parsed || seen.has(parsed.vmfs)) continue;
    seen.add(parsed.vmfs);
    out.push(parsed);
  }
  return out;
}

async function getSnapshotDiskPaths(sdkUrl, cookie, propertyCollector, snapshotId, vmId) {
  if (snapshotId) {
    const xml = await retrieveMoProps(sdkUrl, cookie, propertyCollector, 'VirtualMachineSnapshot', snapshotId, ['config.hardware.device']);
    const disks = diskPathsFromXml(xml);
    if (disks.length) return disks;
  }
  const vmXml = await retrieveMoProps(sdkUrl, cookie, propertyCollector, 'VirtualMachine', vmId, ['config.hardware.device', 'layoutEx', 'snapshot.currentSnapshot']);
  return diskPathsFromXml(vmXml);
}

function connectEsxiSsh({ host, port = 22, username, password }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const onError = (err) => reject(err);
    conn.once('ready', () => {
      conn.removeListener('error', onError);
      resolve(conn);
    });
    conn.once('error', onError);
    conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      finish(prompts.map(() => password || ''));
    });
    conn.connect({
      host,
      port: Number(port) || 22,
      username,
      password,
      tryKeyboard: true,
      readyTimeout: 25000,
      algorithms: {
        kex: [
          'curve25519-sha256',
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
          'diffie-hellman-group-exchange-sha256',
          'diffie-hellman-group1-sha1',
        ],
        serverHostKey: ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-ed25519'],
        cipher: ['aes128-ctr', 'aes256-ctr', 'aes192-ctr', 'aes128-cbc', 'aes256-cbc', '3des-cbc'],
      },
    });
  });
}

function sshExec(conn, command, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ESXi SSH command timed out: ' + command.slice(0, 120))), timeoutMs);
    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }
      let stdout = '';
      let stderr = '';
      stream.stderr.on('data', (d) => { stderr += d; });
      stream.on('data', (d) => { stdout += d; });
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          return reject(new Error((stderr || stdout || 'ESXi SSH command failed').toString().trim() + ' (exit ' + code + ')'));
        }
        resolve({ stdout, stderr });
      });
    });
  });
}

function sshStreamFile(conn, command, destPath, { onProgress, shouldAbort, onAbortStream } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      if (onAbortStream) onAbortStream(stream);
      const out = createWriteStream(destPath);
      let bytes = 0;
      const abortTimer = setInterval(() => {
        if (shouldAbort && shouldAbort()) stream.destroy(new Error('Migration cancelled'));
      }, 500);
      stream.stderr.on('data', () => {});
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (onProgress) onProgress(bytes);
      });
      pipeline(stream, out).then(() => {
        clearInterval(abortTimer);
        resolve({ bytes });
      }).catch((pipeErr) => {
        clearInterval(abortTimer);
        reject(pipeErr);
      });
    });
  });
}

function sshConnRefusedMessage(host, port, err) {
  const msg = String(err && err.message || err || '');
  if (/ECONNREFUSED|ETIMEDOUT|timed out|No response/i.test(msg)) {
    return `ESXi SSH is not reachable at ${host}:${port}. Enable the TSM-SSH (SSH) service on the host, then retry live migration.`;
  }
  if (/authentication|permission denied|All configured authentication methods failed/i.test(msg)) {
    return `ESXi SSH rejected ${host}:${port} credentials. Use the host root (or an SSH-capable) account.`;
  }
  return msg;
}

/**
 * Live disk copy for standalone ESXi: snapshot, vmkfstools clone, SSH-stream the raw -flat.vmdk.
 * Does not use NFC ExportSnapshot (unsupported on many ESXi hosts).
 */
export async function copyLiveDiskOverSsh({
  host,
  port = 443,
  sshPort = 22,
  username,
  password,
  insecure = true,
  vmId,
  destPath,
  onProgress,
  shouldAbort,
  onAbortStream,
} = {}) {
  const cleanHost = String(host || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const sdkUrl = `https://${cleanHost}:${port || 443}/sdk`;
  if (insecure) {
    registerInsecureHost(sdkUrl);
    registerInsecureHost(`https://${cleanHost}`);
  }

  const content = await retrieveServiceContent(sdkUrl);
  const auth = await login({
    sdkUrl,
    sessionManager: content.sessionManager,
    username,
    password,
  });

  let snapshotId = null;
  let conn = null;
  let exportVmfs = null;
  try {
    const powerState = await getVmPowerState(sdkUrl, auth.cookie, content.propertyCollector, vmId);
    if (/poweredOn/i.test(powerState)) {
      const snapName = 'vzbot-live-' + Date.now();
      logger.info('Live SSH: creating snapshot ' + snapName + ' of powered-on VM ' + vmId);
      snapshotId = await createVmSnapshot(sdkUrl, auth.cookie, content.propertyCollector, vmId, snapName);
    }

    const disks = await getSnapshotDiskPaths(sdkUrl, auth.cookie, content.propertyCollector, snapshotId, vmId);
    if (!disks.length) {
      throw new Error('Could not resolve a VMDK path on the ESXi host for SSH clone');
    }
    const src = disks[0];
    const dir = src.vmfs.replace(/\/[^/]+$/, '');
    exportVmfs = dir + '/vzbot-ssh-' + String(vmId).replace(/[^a-zA-Z0-9_-]/g, '') + '-' + Date.now() + '.vmdk';

    try {
      conn = await connectEsxiSsh({ host: cleanHost, port: sshPort, username, password });
    } catch (err) {
      throw new Error(sshConnRefusedMessage(cleanHost, sshPort, err));
    }

    logger.info('Live SSH: vmkfstools clone ' + src.vmfs + ' -> ' + exportVmfs);
    await sshExec(
      conn,
      'vmkfstools -i ' + shQuote(src.vmfs) + ' ' + shQuote(exportVmfs) + ' -d thin',
      3 * 60 * 60 * 1000
    );

    const flat = exportVmfs.replace(/\.vmdk$/i, '-flat.vmdk');
    const listed = await sshExec(conn, 'ls -1 ' + shQuote(flat) + ' ' + shQuote(exportVmfs) + ' 2>/dev/null || true');
    const streamPath = /\-flat\.vmdk/i.test(listed.stdout) ? flat : exportVmfs;
    logger.info('Live SSH: streaming ' + streamPath + ' to ' + destPath);
    const copied = await sshStreamFile(
      conn,
      'dd if=' + shQuote(streamPath) + ' bs=4194304',
      destPath,
      { onProgress, shouldAbort, onAbortStream }
    );
    if (!copied.bytes) throw new Error('ESXi SSH dd copied 0 bytes from ' + streamPath);
    return { bytes: copied.bytes, source: src.vmfs, snapshotId };
  } finally {
    if (conn && exportVmfs) {
      try { await sshExec(conn, 'vmkfstools -U ' + shQuote(exportVmfs), 120000); } catch (_) {}
    }
    if (conn) try { conn.end(); } catch (_) {}
    if (snapshotId) {
      await removeVmSnapshot(sdkUrl, auth.cookie, content.propertyCollector, snapshotId);
    }
    await logout({
      sdkUrl,
      sessionManager: content.sessionManager,
      cookie: auth.cookie,
    });
  }
}

export async function pingHttpNfcLease(lease, percent = 50) {
  if (!lease?.leaseId) return;
  const n = Number(percent);
  const value = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 50;
  await nfcLeaseAction(
    lease.sdkUrl,
    lease.cookie,
    lease.leaseId,
    'HttpNfcLeaseProgress',
    `<vim25:percent>${value}</vim25:percent>`
  );
}

export async function completeHttpNfcLease(lease) {
  if (!lease?.leaseId) return;
  try {
    await nfcLeaseAction(lease.sdkUrl, lease.cookie, lease.leaseId, 'HttpNfcLeaseComplete');
  } catch (err) {
    logger.warn(`HttpNfcLeaseComplete failed: ${err.message}`);
  }
  await removeVmSnapshot(lease.sdkUrl, lease.cookie, lease.propertyCollector, lease.snapshotId);
  await logout({
    sdkUrl: lease.sdkUrl,
    sessionManager: lease.sessionManager,
    cookie: lease.cookie,
  });
}

export async function abortHttpNfcLease(lease) {
  if (!lease?.leaseId) return;
  try {
    await nfcLeaseAction(lease.sdkUrl, lease.cookie, lease.leaseId, 'HttpNfcLeaseAbort');
  } catch (_) {}
  await removeVmSnapshot(lease.sdkUrl, lease.cookie, lease.propertyCollector, lease.snapshotId);
  await logout({
    sdkUrl: lease.sdkUrl,
    sessionManager: lease.sessionManager,
    cookie: lease.cookie,
  });
}

/**
 * Download the first virtual disk from an NFC lease to destPath.
 * Keeps the lease alive with progress pings while the HTTP body streams.
 */
export async function downloadNfcDisk(lease, destPath, { onProgress, shouldAbort, onAbortStream } = {}) {
  const disk = lease?.disks?.[0];
  if (!disk?.url) throw new Error('NFC lease has no disk URL');
  registerInsecureHost(disk.url);

  const progressTimer = setInterval(() => {
    nfcLeaseAction(
      lease.sdkUrl,
      lease.cookie,
      lease.leaseId,
      'HttpNfcLeaseProgress',
      '<vim25:percent>50</vim25:percent>'
    ).catch(() => {});
  }, 15000);

  try {
    const res = await fetch(disk.url, {
      headers: {
        Cookie: lease.cookie || '',
        'User-Agent': 'vz-bot-nfc/1.0',
      },
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`NFC download failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const out = createWriteStream(destPath);
    let bytes = 0;
    const nodeStream = Readable.fromWeb(res.body);
    if (onAbortStream) onAbortStream(nodeStream);
    const abortTimer = setInterval(() => {
      if (shouldAbort && shouldAbort()) nodeStream.destroy(new Error('Migration cancelled'));
    }, 500);
    try {
      nodeStream.on('data', (chunk) => {
        bytes += chunk.length;
        if (onProgress) onProgress(bytes);
      });
      await pipeline(nodeStream, out);
    } finally {
      clearInterval(abortTimer);
    }
    await nfcLeaseAction(
      lease.sdkUrl,
      lease.cookie,
      lease.leaseId,
      'HttpNfcLeaseProgress',
      '<vim25:percent>100</vim25:percent>'
    ).catch(() => {});
    return { bytes, url: disk.url };
  } finally {
    clearInterval(progressTimer);
  }
}
