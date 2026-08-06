import os
import sys
import openstack
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

base_url = os.getenv("VHI_BASE_URL", "https://172.16.218.7")
auth_url = f"{base_url}:5000/v3"

try:
    print("Connecting via openstacksdk...")
    conn = openstack.connect(
        auth_url=auth_url,
        project_name=os.getenv("VHI_PROJECT_NAME", "admin"),
        username=os.getenv("VHI_USER", "admin"),
        password=os.getenv("VHI_PASSWORD", ""),
        user_domain_name=os.getenv("VHI_DOMAIN_NAME", "Default"),
        project_domain_name=os.getenv("VHI_DOMAIN_NAME", "Default"),
        verify=False
    )
    
    print("Connection successful.")
    compute_endpoint = conn.compute.get_endpoint()
    print(f"Compute Endpoint used by SDK: {compute_endpoint}")
    
    # Try to get a VNC console directly using the SDK method
    servers = list(conn.compute.servers(limit=1))
    if servers:
        server = servers[0]
        print(f"Testing console on server: {server.id}")
        
        try:
            print("Trying create_server_remote_console (remote-console)...")
            console = conn.compute.create_server_remote_console(server, protocol='vnc', type='novnc')
            print(f"SUCCESS: {console.url}")
        except Exception as e:
            print(f"FAILED: {e}")
            
except Exception as e:
    print(f"Error: {e}")
