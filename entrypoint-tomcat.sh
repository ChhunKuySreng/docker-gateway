#!/bin/bash
set -e

# Always ensure clean system webapps (manager, host-manager, ROOT) match current Tomcat version
for sysapp in manager host-manager ROOT docs examples; do
    if [ -d "/usr/local/tomcat/webapps.template/$sysapp" ]; then
        mkdir -p "/usr/local/tomcat/webapps/$sysapp"
        cp -rn "/usr/local/tomcat/webapps.template/$sysapp/"* "/usr/local/tomcat/webapps/$sysapp/" 2>/dev/null || true
        # Ensure images are updated to match current version
        if [ -d "/usr/local/tomcat/webapps.template/$sysapp/images" ]; then
            cp -r "/usr/local/tomcat/webapps.template/$sysapp/images/"* "/usr/local/tomcat/webapps/$sysapp/images/" 2>/dev/null || true
        fi
    fi
done

# Ensure remote valve restrictions are removed from manager & host-manager for Tailscale access
for app in manager host-manager; do
    if [ -d "/usr/local/tomcat/webapps/$app/META-INF" ]; then
        cat << 'EOF' > "/usr/local/tomcat/webapps/$app/META-INF/context.xml"
<?xml version="1.0" encoding="UTF-8"?>
<Context antiResourceLocking="false" privileged="true" >
  <CookieProcessor className="org.apache.tomcat.util.http.Rfc6265CookieProcessor"
                   sameSiteCookies="strict" />
</Context>
EOF
    fi
done

# Configure Tomcat Manager credentials from environment variables
if [ -n "$TOMCAT_ADMIN_PASSWORD" ]; then
    cat << EOF > /usr/local/tomcat/conf/tomcat-users.xml
<?xml version="1.0" encoding="UTF-8"?>
<tomcat-users xmlns="http://tomcat.apache.org/xml"
              xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
              xsi:schemaLocation="http://tomcat.apache.org/xml tomcat-users.xsd"
              version="1.0">
  <role rolename="manager-gui"/>
  <role rolename="manager-script"/>
  <role rolename="manager-jmx"/>
  <role rolename="manager-status"/>
  <role rolename="admin-gui"/>
  <role rolename="admin-script"/>
  <user username="${TOMCAT_ADMIN_USER}" password="${TOMCAT_ADMIN_PASSWORD}" roles="manager-gui,admin-gui"/>
  <user username="tomcat" password="${TOMCAT_ADMIN_PASSWORD}" roles="manager-gui,admin-gui"/>
  <user username="deployer" password="${TOMCAT_ADMIN_PASSWORD}" roles="manager-script,admin-script"/>
</tomcat-users>
EOF
fi

exec catalina.sh run
