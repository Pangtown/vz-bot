import os
import logging
import openstack
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Enable debug logging for python-keystoneclient and python-openstackclient
import http.client as http_client
http_client.HTTPConnection.debuglevel = 1

logging.basicConfig(level=logging.DEBUG)

try:
    conn = openstack.connect(
        auth_url=os.getenv("VHI_BASE_URL", "https://172.16.218.7") + ":5000/v3",
        project_name=os.getenv("VHI_PROJECT_NAME", "admin"),
        username=os.getenv("VHI_USER", "admin"),
        password=os.getenv("VHI_PASSWORD", ""),
        user_domain_name=os.getenv("VHI_DOMAIN_NAME", "Default"),
        project_domain_name=os.getenv("VHI_DOMAIN_NAME", "Default"),
        verify=False
    )
    print("Servers:", list(conn.compute.servers()))
except Exception as e:
    print("Failed:", e)
