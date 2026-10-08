Pod::Spec.new do |s|
  s.name           = 'Storefront'
  s.version        = '1.0.0'
  s.summary        = 'The App Store storefront the user buys from.'
  s.description    = 'Reads StoreKit Storefront.current, so purchase links follow store rules.'
  s.license        = 'UNLICENSED'
  s.author         = 'Savorly'
  s.homepage       = 'https://savorly.app'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
