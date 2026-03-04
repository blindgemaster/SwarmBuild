import os
import re
from github import Github
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

def generate_deploy_key_pair():
    """Generates an Ed25519 SSH keypair for deployment."""
    private_key = ed25519.Ed25519PrivateKey.generate()
    
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.OpenSSH,
        encryption_algorithm=serialization.NoEncryption()
    )
    
    public_key = private_key.public_key()
    public_ssh = public_key.public_bytes(
        encoding=serialization.Encoding.OpenSSH,
        format=serialization.PublicFormat.OpenSSH
    )
    
    return private_pem.decode('utf-8'), public_ssh.decode('utf-8')

from config import get_settings

def provision_job_repository(job_title: str):
    """
    Creates a new GitHub repository for a Swarmbuild job and provisions a Deploy Key.
    Requires GITHUB_TOKEN in environment variables.
    """
    token = get_settings().github_token
    if not token:
        raise Exception("GITHUB_TOKEN is not configured in the environment.")
    
    g = Github(token)
    
    # Sanitize title for repo name
    clean_name = re.sub(r'[^a-zA-Z0-9-]', '-', job_title.lower())
    clean_name = re.sub(r'-+', '-', clean_name).strip('-')
    suffix = os.urandom(3).hex()
    repo_name = f"swarmbuild-{clean_name}-{suffix}"
    
    user = g.get_user()

    # Check if repo already exists
    try:
        repo = user.get_repo(repo_name)
    except Exception:
        # Create it if not found
        repo = user.create_repo(
            name=repo_name,
            description=f"Swarmbuild auto-provisioned job repository for '{job_title}'",
            private=False,
            auto_init=True
        )
    
    # Generate Keypair
    priv_key, pub_key = generate_deploy_key_pair()
    
    # Add deploy key (with write access so agents can push back)
    # We prefix to ensure it doesn't conflict if we run multiple times in dev
    repo.create_key(title=f"swarmbuild-worker-{os.urandom(4).hex()}", key=pub_key, read_only=False)
    
    return {
        "repo_name": repo.full_name,
        "clone_url": repo.clone_url,
        "ssh_url": repo.ssh_url,
        "html_url": repo.html_url,
        "deploy_key_private": priv_key
    }
