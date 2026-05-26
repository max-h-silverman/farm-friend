"""Firestore data layer.

This is the ONLY package that imports `google.cloud.firestore` directly.
Business logic calls into the repo modules below; if we ever migrate off
Firestore, this layer is the migration surface.
"""
