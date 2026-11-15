# Create an isolated XCTest host so Xcode cannot rebuild or replace the
# separately installed PasoFi Release app that the operator will receive.
require 'xcodeproj'
require 'fileutils'
work, test_file = ARGV
FileUtils.mkdir_p(work)
Dir.chdir(work) do
  project = Xcodeproj::Project.new('InstalledClient.xcodeproj')
  host = project.new_target(:application, 'QualificationHost', :ios, '17.0')
  File.write('main.m', <<~OBJC)
    #import <UIKit/UIKit.h>
    @interface Delegate : UIResponder<UIApplicationDelegate>
    @end
    @implementation Delegate
    @end
    int main(int argc, char *argv[]) {
      @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass([Delegate class])); }
    }
  OBJC
  host.source_build_phase.add_file_reference(project.main_group.new_file('main.m'))
  tests = project.new_target(:ui_test_bundle, 'InstalledClientTests', :ios, '17.0')
  FileUtils.cp(test_file, 'ConfiguredAccessTests.swift')
  tests.source_build_phase.add_file_reference(project.main_group.new_file('ConfiguredAccessTests.swift'))
  tests.add_dependency(host)
  [host, tests].each do |target|
    target.build_configurations.each do |config|
      settings = config.build_settings
      settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.onesa.qualification.' + target.name
      settings['GENERATE_INFOPLIST_FILE'] = 'YES'
      settings['SUPPORTED_PLATFORMS'] = 'iphonesimulator'
      settings['INFOPLIST_KEY_UILaunchScreen_Generation'] = 'YES' if target == host
      settings['TARGETED_DEVICE_FAMILY'] = '1,2'
      settings['SWIFT_VERSION'] = '5.0'
      settings['TEST_TARGET_NAME'] = host.name if target == tests
    end
  end
  project.root_object.attributes['TargetAttributes'] = { tests.uuid => { 'TestTargetID' => host.uuid } }
  project.save
  scheme = Xcodeproj::XCScheme.new
  scheme.configure_with_targets(host, tests, launch_target: true)
  scheme.save_as(project.path, 'InstalledClient', true)
end
