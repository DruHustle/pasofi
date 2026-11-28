"""Credential-free proof of optional PasoFi merchant/profile/artifact binding."""
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

import release
import upload


class PasoFiApplePayTests(unittest.TestCase):
    def setUp(self):
        self.config = {"repository": "DruHustle/pasofi", "appId": "com.onesa.pasofi",
                       "framework": "capacitor", "mobilePath": "pasofi-frontend/mobile", "scheme": "App"}
        self.env = {"APPLE_TEAM_ID": "YSD6XK5CLU", "GITHUB_SHA": "a" * 40,
                    "PASOFI_APPLE_PAY_MERCHANT_ID": "merchant.com.onesa.pasofi"}
        self.selected = release.pasofi_apple_pay_selection(self.config, self.env)
        self.disabled = release.pasofi_apple_pay_selection(self.config, {})
        self.record = {"schema": 1, "repository": self.config["repository"], "appId": self.config["appId"],
                       "sourceSha": "a" * 40, "version": "1.0.3", "buildNumber": "17",
                       "pasofiApplePay": self.selected}
        self.cert = b"public-synthetic-distribution-certificate"
        self.pin = hashlib.sha256(self.cert).hexdigest()

    def profile(self):
        return {"UUID": "00000000-0000-4000-8000-000000000000", "TeamIdentifier": ["YSD6XK5CLU"],
                "ExpirationDate": dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1),
                "DeveloperCertificates": [self.cert], "Entitlements": {
                    "application-identifier": "OLDPREFIX.com.onesa.pasofi",
                    "com.apple.developer.team-identifier": "YSD6XK5CLU", "get-task-allow": False,
                    "com.apple.developer.in-app-payments": ["merchant.com.onesa.pasofi"]}}

    def test_blank_default_derives_card_only_path_and_selection_is_product_scoped(self):
        self.assertEqual(self.disabled, {"merchantId": "", "entitlements": "App/PasoFiAssociatedDomains.entitlements"})
        self.assertEqual(self.selected, {"merchantId": "merchant.com.onesa.pasofi",
                                         "entitlements": "App/PasoFiStripe.entitlements"})
        self.assertIsNone(release.pasofi_apple_pay_selection({"repository": "DruHustle/fixture"}, {}))
        for config in ({**self.config, "appId": "com.onesa.other"},
                       {**self.config, "framework": "expo"},
                       {**self.config, "mobilePath": "other"},
                       {**self.config, "scheme": "Other"}, {"repository": "DruHustle/fixture"}):
            with self.subTest(config=config), self.assertRaises(ValueError):
                release.pasofi_apple_pay_selection(config, self.env)

    def test_unreviewed_merchant_wrong_team_and_external_entitlement_path_fail(self):
        changes = [{"PASOFI_APPLE_PAY_MERCHANT_ID": value} for value in
                   ("merchant.other", "merchant.com.onesa.pasofi ", "merchant.*", "$(id)", "\n")]
        changes += [{"APPLE_TEAM_ID": "OTHERTEAM1"}, {"APPLE_TEAM_ID": ""},
                    {"PASOFI_APPLE_PAY_ENTITLEMENTS": "App/PasoFiStripe.entitlements"},
                    {"PASOFI_APPLE_PAY_ENTITLEMENTS": "../../other.entitlements"}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                release.pasofi_apple_pay_selection(self.config, {**self.env, **change})

    def test_app_target_settings_are_not_inherited_by_build_children(self):
        with patch.dict(os.environ, {**self.env, "PASOFI_APPLE_PAY_ENTITLEMENTS": "untrusted", "CI": "1"}, clear=True):
            child = release.public_environment()
        self.assertEqual(child["CI"], "1")
        self.assertNotIn("PASOFI_APPLE_PAY_MERCHANT_ID", child)
        self.assertNotIn("PASOFI_APPLE_PAY_ENTITLEMENTS", child)

    def test_context_freezes_enabled_and_disabled_selection_before_later_stages(self):
        for selected_env in (self.env, {**self.env, "PASOFI_APPLE_PAY_MERCHANT_ID": ""}):
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, selected_env, clear=True), \
                    patch("release.command", return_value=b"a" * 40), \
                    patch("release.source_version", return_value="1.0.3"), patch("release.source_guard.initialize"):
                work = Path(directory)
                record = release.write_context(self.config, work, "17")
                self.assertEqual(release.read_context(self.config, work), record)
                opposite = "" if record["pasofiApplePay"]["merchantId"] else "merchant.com.onesa.pasofi"
                with patch.dict(os.environ, {"PASOFI_APPLE_PAY_MERCHANT_ID": opposite}), \
                        self.assertRaisesRegex(ValueError, "selection changed"):
                    release.read_context(self.config, work)
                del record["pasofiApplePay"]
                (work / "context.json").write_text(json.dumps(record))
                with self.assertRaisesRegex(ValueError, "selection changed"):
                    release.read_context(self.config, work)

    def test_profile_requires_explicit_selected_merchant_and_preserves_legacy_app_prefix(self):
        profile = self.profile()
        profile["Entitlements"]["com.apple.developer.in-app-payments"].append("merchant.other.authorized")
        self.assertEqual(release.validate_profile(profile, self.config, "YSD6XK5CLU", self.pin, apple_pay=self.selected),
                         "OLDPREFIX.com.onesa.pasofi")
        for merchants in (None, [], ["merchant.other"], ["merchant.*"], "merchant.com.onesa.pasofi",
                          ["merchant.com.onesa.pasofi", "*"]):
            profile = self.profile()
            profile["Entitlements"]["com.apple.developer.in-app-payments"] = merchants
            with self.subTest(merchants=merchants), self.assertRaisesRegex(ValueError, "authorize"):
                release.validate_profile(profile, self.config, "YSD6XK5CLU", self.pin, apple_pay=self.selected)
        profile = self.profile()
        del profile["Entitlements"]["com.apple.developer.in-app-payments"]
        release.validate_profile(profile, self.config, "YSD6XK5CLU", self.pin, apple_pay=self.disabled)

    def test_missing_profile_merchant_stops_before_keychain_or_identity_import(self):
        profile = self.profile()
        profile["ExpirationDate"] = profile["ExpirationDate"].replace(tzinfo=None)
        del profile["Entitlements"]["com.apple.developer.in-app-payments"]
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                **self.env, "APPLE_DISTRIBUTION_CERT_SHA256": self.pin}, clear=True), \
                patch("release.source_guard.verify"), patch("release.decode_secret"), \
                patch("release.command", side_effect=[b"", plistlib.dumps(profile)]) as command:
            with self.assertRaisesRegex(ValueError, "authorize"):
                release.sign_ios(self.config, self.record, Path(directory))
        self.assertEqual([call.args[:3] for call in command.call_args_list],
                         [("security", "list-keychains", "-d"), ("security", "cms", "-D")])

    def test_existing_entitlement_sources_preserve_both_identity_domains(self):
        release.validate_pasofi_entitlement_sources(self.config)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / self.config["mobilePath"] / "ios/App/App"
            folder.mkdir(parents=True)
            for filename in ("PasoFiAssociatedDomains.entitlements", "PasoFiStripe.entitlements"):
                original = release.ROOT / self.config["mobilePath"] / "ios/App/App" / filename
                (folder / filename).write_bytes(original.read_bytes())
            release.validate_pasofi_entitlement_sources(self.config, root)
            wallet = folder / "PasoFiStripe.entitlements"
            value = plistlib.loads(wallet.read_bytes())
            value["com.apple.developer.associated-domains"].pop()
            wallet.write_bytes(plistlib.dumps(value))
            with self.assertRaisesRegex(ValueError, "entitlement source changed"):
                release.validate_pasofi_entitlement_sources(self.config, root)

    def test_exported_info_must_match_frozen_merchant_and_entitlement_path(self):
        base = {"CFBundleIdentifier": self.config["appId"], "CFBundleVersion": "17",
                "CFBundleShortVersionString": "1.0.3", "CFBundleSupportedPlatforms": ["iPhoneOS"],
                "DTPlatformName": "iphoneos", "DTXcode": "2600"}
        for selection in (self.selected, self.disabled):
            record = {**self.record, "pasofiApplePay": selection}
            info = {**base, "PasoFiApplePayMerchantIdentifier": selection["merchantId"],
                    "PasoFiApplePayEntitlements": selection["entitlements"]}
            release.validate_ios_info(info, self.config, record)
            for key in ("PasoFiApplePayMerchantIdentifier", "PasoFiApplePayEntitlements"):
                for value in (None, "other", "$(UNRESOLVED)"):
                    with self.subTest(selection=selection, key=key, value=value), self.assertRaisesRegex(ValueError, "Info.plist"):
                        release.validate_ios_info({**info, key: value}, self.config, record)

    def test_signed_entitlements_allow_only_selected_merchant_and_existing_domains(self):
        for selection in (self.selected, self.disabled):
            expected = [selection["merchantId"]] if selection["merchantId"] else []
            entitlements = {"com.apple.developer.associated-domains": list(release.PASOFI_ASSOCIATED_DOMAINS),
                            "com.apple.developer.in-app-payments": expected}
            release.validate_pasofi_signed_entitlements(entitlements, selection)
            for merchants in (["merchant.other"], [*expected, "merchant.other"], "merchant.com.onesa.pasofi", None):
                with self.subTest(selection=selection, merchants=merchants), self.assertRaises(ValueError):
                    release.validate_pasofi_signed_entitlements({**entitlements, "com.apple.developer.in-app-payments": merchants}, selection)
            for domains in ([], ["applinks:pasofi.mobile.onesa.eu"], [*release.PASOFI_ASSOCIATED_DOMAINS, "applinks:other"], None):
                with self.subTest(domains=domains), self.assertRaises(ValueError):
                    release.validate_pasofi_signed_entitlements({**entitlements, "com.apple.developer.associated-domains": domains}, selection)
        release.validate_pasofi_signed_entitlements({"com.apple.developer.associated-domains": release.PASOFI_ASSOCIATED_DOMAINS}, self.disabled)

    def test_changed_receipt_selection_blocks_before_any_apple_provider_call(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            artifacts = work / "artifacts"
            artifacts.mkdir()
            artifact = artifacts / "upload.ipa"
            artifact.write_bytes(b"synthetic-unsigned-fixture-not-an-ipa")
            receipt = {**copy.deepcopy(self.record), "platform": "ios", "artifactSha256": release.sha256(artifact),
                       "preparedSourceSha256": "b" * 64, "distribution": "signed-not-uploaded"}
            receipt["pasofiApplePay"] = self.disabled
            receipt_file = artifacts / "receipt.json"
            receipt_file.write_text(json.dumps(receipt))
            before = receipt_file.read_bytes()
            with patch("upload.upload_apple") as provider, self.assertRaisesRegex(ValueError, "receipt changed"):
                upload.upload(self.config, self.record, "ios", work, source_digest="b" * 64)
            provider.assert_not_called()
            self.assertEqual(receipt_file.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
