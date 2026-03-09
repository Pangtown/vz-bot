# VHI Infrastructure skill

Use these tools when the user asks about or wants to manage VHI 7.x infrastructure.

## When to use which tool

- **"List VMs" / "What's running?" / "Status"** → `list_vms` or `run_health_check`
- **"Details of VM X"** → `get_vm` with server_id
- **"Restart VM X" / "Reboot server X"** → `reboot_vm` (prefer SOFT). Confirm server name/id if ambiguous.
- **"Start VM X"** → `start_vm`
- **"Stop VM X"** → `stop_vm`
- **"Health check" / "How is the infrastructure?"** → `run_health_check`
- **"List volumes" / "Storage"** → `list_volumes`
- **"List networks"** → `list_networks`

## Safety

- For destructive actions (delete server, delete volume), state clearly what will be deleted and ask the user to confirm before proceeding.
- Prefer listing or describing resources before changing them so the user can verify.
