# Run in RouterOS Safe Mode on a PasoFi HotSpot gateway. Change profileName
# to the single inspected radio, guest VLAN, or LAN HotSpot profile.
{
 :local profileName "REPLACE_ME";
 :local targets [/ip hotspot profile find where name=$profileName];
 :if ([:len $targets] != 1) do={ :error "Select one existing PasoFi HotSpot profile"; };
 :local profile [:pick $targets 0];
 :local hotspotName [/ip hotspot profile get $profile dns-name];
 :if (($hotspotName != "login.pasofi.mobile.onesa.eu") && ($hotspotName != "wifi.pasofi.mobile.onesa.eu")) do={ :error "Unexpected HotSpot DNS name"; };
 :if ([:len [/ip hotspot find where profile=$profileName disabled=no]] != 1) do={ :error "Expected one enabled HotSpot using this profile"; };
 :local loginMethods [/ip hotspot profile get $profile login-by];
 :local trialEnabled false;
 :foreach method in=[:toarray $loginMethods] do={ :if ($method = "trial") do={ :set trialEnabled true; }; };
 :if (!$trialEnabled) do={ :error "The profile does not already allow local trial"; };
 :local trialName [/ip hotspot profile get $profile trial-user-profile];
 :local trialProfiles [/ip hotspot user profile find where name=$trialName];
 :if (($trialName = "default") || ([:len $trialProfiles] != 1)) do={ :error "An existing dedicated trial user profile is required"; };
 :if ([:len [/ip hotspot user find where profile=$trialName]] != 0) do={ :error "The trial user profile is assigned to a local user"; };
 :local trial [:pick $trialProfiles 0];
 :put ("Previous duration/reset: " . [/ip hotspot profile get $profile trial-uptime-limit] . "/" . [/ip hotspot profile get $profile trial-uptime-reset]);
 :put ("Previous trial-user-profile rate: " . [/ip hotspot user profile get $trial rate-limit]);
 /ip hotspot user profile set $trial rate-limit="1M/3M";
 /ip hotspot profile set $profile trial-uptime-limit=5m trial-uptime-reset=1d;
 :if (([/ip hotspot profile get $profile trial-uptime-limit] != 5m) || ([/ip hotspot profile get $profile trial-uptime-reset] != 1d) || ([/ip hotspot user profile get $trial rate-limit] != "1M/3M")) do={ :error "Trial readback failed; exit Safe Mode by disconnecting to revert"; };
 :put ("Verified " . $profileName . " at " . $hotspotName . " with trial profile " . $trialName);
}
