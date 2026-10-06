# Public Release Preparation Plan

## Goal
Prepare a clean, sanitized `public` branch of the codebase suitable for public consumption, removing sensitive files, credentials, and test artifacts, and clearly labeling Disaster Recovery and Migration tools as Experimental in the UI and documentation.

## Tasks
- [ ] Task 1: Create and switch to new branch `public` → Verify: `git branch --show-current` outputs `public`
- [ ] Task 2: Remove sensitive tracked files (backup files with passwords, live DBs, historical dumps, scratch/tmp files) from git tracking → Verify: `git ls-files data/ backups/ scratch/ tmp/ *.txt` shows only intended tracked code
- [ ] Task 3: Create sanitized configuration templates (`data/ssh_config.json.example`) and verify startup auto-creation of data dirs → Verify: `data/ssh_config.json.example` exists with placeholder credentials
- [ ] Task 4: Update `.gitignore` to prevent committing databases, backups, logs, and sensitive data while allowing `.example` templates → Verify: `git status` ignores data DBs and logs
- [ ] Task 5: Add "Experimental" badges/labels to Disaster Recovery and Migrations in sidebar navigation (`public/js/vhi-common.js`) and styling (`public/vhi.css`) → Verify: Sidebar renders "Migrations" and "Disaster Recovery" with experimental indicators
- [ ] Task 6: Add "Experimental" headers/banners to `public/migrations.html` and `public/dr.html` → Verify: Both pages clearly announce experimental status
- [ ] Task 7: Update `README.md` documenting experimental DR/Migration features and setup instructions → Verify: README references experimental tools and clean startup
- [ ] Task 8: Run automated tests and validation suite → Verify: `npm test` passes without errors
- [ ] Task 9: Commit changes to the `public` branch → Verify: Clean working tree on `public` branch

## Done When
- [ ] `public` branch exists and contains no tracked live databases, credentials, or backup dumps
- [ ] DR and Migration tools are clearly branded as Experimental in sidebar navigation and page headers
- [ ] Test suite passes on `public` branch
- [ ] Clean working tree committed on `public`

## Notes
- Live passwords (`Virtuozzo123!`, `VirtuozzoD3m0!`, `@c7r841JWMe%9Z3Pj5W`) existed in historical commits on HEAD; user has acknowledged and will rotate credentials before remote push.
