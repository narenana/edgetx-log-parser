# Share migration compatibility — 24 September 2026

The previous website Worker injects a legacy `#nn-shr` widget into proxied log pages. The new app-owned share launcher now suppresses that legacy widget only when the new launcher exists. This protects the transition when the app is released before the website Worker and a rollback to the prior Worker.

Verification: successful web build and content-revisioned cache postbuild gate. A local proxy fixture injected the old widget into the built app and guides. Browser inspection verified legacy display `none`, modern display `flex`, and the guide's public canonical URL. The updated real local Worker also retains its previously verified single-launcher behavior. No production change, push or deployment.
