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
        auth_url="https://172.16.218.7:5000/v3",
        project_name="admin",
        username="admin",
        password="Nexpass8188!",
        user_domain_name="Default",
        project_domain_name="Default",
        verify=False
    )
    print("Servers:", list(conn.compute.servers()))
except Exception as e:
    print("Failed:", e)
