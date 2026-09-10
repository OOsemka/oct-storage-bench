FROM docker.io/library/nginx:1.27-alpine

RUN chmod -R 777 /var/cache/nginx /var/run /var/log/nginx /usr/share/nginx/html /etc/nginx

COPY dist/ /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

USER 1001

ENTRYPOINT ["nginx", "-g", "daemon off;"]
