import os
import json
import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

base_url = os.getenv("VHI_BASE_URL", "https://172.16.218.7")
auth_url = f"{base_url}:5000/v3/auth/tokens"

auth_data = {
    "auth": {
        "identity": {
            "methods": ["password"],
            "password": {
                "user": {
                    "domain": {"name": "Default"},
                    "name": os.getenv("VHI_USER", "admin"),
                    "password": os.getenv("VHI_PASSWORD", "")
                }
            }
        },
        "scope": {
            "project": {
                "domain": {"name": "Default"},
                "name": "admin"
            }
        }
    }
}

print("Getting token...")
r = requests.post(auth_url, json=auth_data, verify=False)
token = r.headers.get("X-Subject-Token")
catalog = r.json().get('token', {}).get('catalog', [])

print("Getting compute endpoint...")
compute_url = None
for service in catalog:
    if service['type'] == 'compute':
        for endpoint in service['endpoints']:
            if endpoint['interface'] == 'public':
                compute_url = endpoint['url']
                break

print(f"Compute URL from catalog: {compute_url}")

# Fallback if catalog missing
if not compute_url:
    compute_url = f"{base_url}:8774/v2.1"
    
print("Getting servers...")
r = requests.get(f"{compute_url}/servers", headers={"X-Auth-Token": token}, verify=False)
servers = r.json().get('servers', [])
if not servers:
    print("No servers found")
    exit(0)

server_id = servers[0]['id']
action_url = f"{compute_url}/servers/{server_id}/action"

print(f"\nTesting os-getVNCConsole against {action_url}")
r = requests.post(
    action_url,
    headers={"X-Auth-Token": token, "Content-Type": "application/json"},
    json={"os-getVNCConsole": {"type": "novnc"}},
    verify=False
)
print(f"Status: {r.status_code}")
print(f"Response: {r.text[:300]}")

print(f"\nTesting remote-console against {action_url}")
r = requests.post(
    action_url,
    headers={"X-Auth-Token": token, "Content-Type": "application/json", "Openstack-Api-Version": "compute 2.67"},
    json={"remote-console": {"protocol": "vnc", "type": "novnc"}},
    verify=False
)
print(f"Status: {r.status_code}")
print(f"Response: {r.text[:300]}")
