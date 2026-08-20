package switchos.authz

default allow := false

read_permissions := {"read_platform", "read_analytics", "read", "analytics"}
privileged_permissions := {"write_platform", "write_analytics", "operate"}
operational_roles := {"admin", "operator", "ops"}

allow if {
  input.permission in read_permissions
  input.subject.role in operational_roles
}

allow if {
  input.permission in privileged_permissions
  input.subject.role in operational_roles
  input.subject.mfa == true
}
