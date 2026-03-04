"""
GitHub Client — Repo creation and access management for Swarmbuild jobs

Each job gets its own GitHub repo. Contributors push directly to it.
"""

from github import Github, GithubException
from typing import Optional


class SwarmbuildGitHubClient:
    """Manages GitHub repos for Swarmbuild jobs."""

    def __init__(self, access_token: str, org_name: str = "swarmbuild-jobs"):
        self.github = Github(access_token)
        self.org_name = org_name

    def create_job_repo(
        self,
        job_id: str,
        title: str,
        description: str,
    ) -> dict:
        """
        Create a new GitHub repo for a job.
        Returns { repo_name, clone_url, html_url }.
        """
        try:
            org = self.github.get_organization(self.org_name)
        except GithubException:
            # Fall back to user repos if org doesn't exist
            org = self.github.get_user()

        repo_name = f"job-{job_id[:8]}"
        repo_description = f"Swarmbuild: {title}"

        try:
            repo = org.create_repo(
                name=repo_name,
                description=repo_description[:350],
                private=False,
                auto_init=True,
                has_issues=False,
                has_wiki=False,
            )
        except GithubException as e:
            if e.status == 422:  # Already exists
                repo = org.get_repo(repo_name)
            else:
                raise

        return {
            "repo_name": f"{self.org_name}/{repo_name}",
            "clone_url": repo.clone_url,
            "html_url": repo.html_url,
        }

    def create_deploy_key(self, repo_name: str, public_key: str) -> None:
        """Add a deploy key to a repo for worker write access."""
        repo = self.github.get_repo(repo_name)
        repo.create_key(
            title="swarmbuild-worker",
            key=public_key,
            read_only=False,
        )

    def get_clone_url_with_token(self, repo_name: str, token: str) -> str:
        """Build a clone URL with embedded access token."""
        return f"https://x-access-token:{token}@github.com/{repo_name}.git"

    def delete_repo(self, repo_name: str) -> None:
        """Delete a job repo (cleanup on cancellation)."""
        try:
            repo = self.github.get_repo(repo_name)
            repo.delete()
        except GithubException:
            pass
