begin;
insert into recruitment.auth_user (tenant_id, username, password_hash, display_name, alias)
values ('11111111-1111-4111-8111-000000000001'::uuid, 'hr_admin_e2e91', 'scrypt$16384$8$1$7e4130a5f9fe18ccc8183178de0ef5f4$b05b1e2b56f04374d82894075b6efaa2789d22ad85cb26402e4b74b106e4c879524c241851e03bedb0b6fe80f8a9b2058a9da779039c364bdcc1ebe60a62f5e6', 'E2E 验收管理员', 'recruiter')
on conflict (tenant_id, username) do update set
  password_hash = excluded.password_hash,
  display_name = excluded.display_name,
  alias = excluded.alias,
  disabled_at = null;
-- 首次上线替换完正式账号后，建议取消下方注释以禁用本地演示账号：
-- update recruitment.auth_user set disabled_at = now() where tenant_id = '11111111-1111-4111-8111-000000000001'::uuid and username in ('recruiter', 'interviewer');
commit;
