PasoFi — Mac deployment package

When ready to deploy:
1. Extract the ZIP and keep its files together.
2. Double-click Start_PasoFi.command.
   Or open Terminal in this folder and run: /bin/bash ./Start_PasoFi.command

The server aliases and public addresses are already filled in. The launcher
discovers the recorded installation details, validates a fresh backup by an
exact isolated restore, deploys, runs postchecks and opens its result report.
There is no configuration questionnaire or second APPLY prompt.

Existing Python 3.9+, OpenSSH, the unlocked SSH key/agent and trusted server
host records are required on your Mac. No passwords or private keys are bundled.

For read-only observations first, run hotspot-readiness.command.
For details, read PasoFi_Mac_Deployment_Guide.md and RELEASE_EVIDENCE.json.

This package is prepared software. Running it performs the deployment.
Real router/customer acceptance must still pass before serving customers.
